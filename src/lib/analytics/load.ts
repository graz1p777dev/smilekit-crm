// Расчёт аналитики владельца: только факты из базы, по правилам, которые
// видны в интерфейсе. Тяжёлый счёт — SQL-функции (миграции 048, 049), здесь
// вызов, типы клиентов и часы смен. Права проверяют server actions
// (src/actions/analytics.ts) — сюда без проверки не попадают.

import { createAdminClient } from '@/lib/supabase/admin'
import type { PeriodRange } from '@/lib/analytics/period'
import {
  CLIENT_TYPE_ORDER,
  classifyClient,
  type ClientFacts,
  type ClientType,
} from '@/lib/analytics/client-types'
import { computeStaffHours, type StaffHours } from '@/lib/analytics/shift-hours'
import { buildBotFunnel, type BotFunnel } from '@/lib/analytics/bot-funnel'
import { detectCity, type Country } from '@/lib/analytics/city'

// ─── Кэш на 2 минуты по периоду ─────────────────────────────────────────────

const CACHE_TTL_MS = 2 * 60_000
const cache = new Map<string, { at: number; data: unknown }>()

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data as T
  const data = await load()
  cache.set(key, { at: Date.now(), data })
  return data
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await createAdminClient().rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

const rangeArgs = (range: PeriodRange) => ({ p_from: range.fromIso, p_to: range.toIso })

// ─── Лиды, конверсия, типы клиентов ─────────────────────────────────────────

export interface ChatRef {
  chatId: string
  name: string | null
  dealId: string | null
}

export interface WaitingRow extends ChatRef {
  /** Первое сообщение клиента, на которое ещё не было ответа. */
  since: string
  lastAt: string
  lastText: string
}

export interface TypeClientRow extends ChatRef {
  totalMsgs: number
  msgsBeforeOrder: number | null
  msToOrder: number | null
}

export interface ReplyGroup {
  leads: number
  bought: number
}

export interface LeadsAnalytics {
  range: PeriodRange
  generatedAt: string
  dataSince: string | null
  wrote: number
  newLeads: number
  human: number
  botOnly: number
  noReply: number
  waitingTotal: number
  waiting: WaitingRow[]
  conversion: {
    bought: number
    human: ReplyGroup
    botOnly: ReplyGroup
    noReply: ReplyGroup
  }
  types: { type: ClientType; count: number; clients: TypeClientRow[] }[]
}

type CohortTuple = [string, number, number, number, 0 | 1, 0 | 1, number | null, number | null, 0 | 1]

interface LeadsRpc {
  wrote: number
  newLeads: number
  human: number
  botOnly: number
  noReply: number
  waitingTotal: number
  waiting: { chatId: string; since: string; lastAt: string; lastText: string; name: string | null; dealId: string | null }[]
  cohort: CohortTuple[]
  dataSince: string | null
}

const LIST_LIMIT = 100

export async function loadLeads(range: PeriodRange): Promise<LeadsAnalytics> {
  return cached(`leads:${range.fromIso}:${range.toIso}`, async () => {
    const raw = await rpc<LeadsRpc>('analytics_leads', rangeArgs(range))

    const conversion = {
      bought: 0,
      human: { leads: 0, bought: 0 },
      botOnly: { leads: 0, bought: 0 },
      noReply: { leads: 0, bought: 0 },
    }
    const buckets = new Map<ClientType, { count: number; rows: TypeClientRow[] }>(
      CLIENT_TYPE_ORDER.map((t) => [t, { count: 0, rows: [] }])
    )

    // Когорта уже отсортирована SQL: новые лиды, свежие сверху.
    for (const [chatId, , firstDialogAt, totalMsgs, humanAfter, botAfter, firstOrderAt, msgsBeforeOrder, humanAfterLast] of raw.cohort) {
      const facts: ClientFacts = {
        firstDialogAt,
        totalMsgs,
        firstOrderAt,
        msgsBeforeOrder,
        humanAfterLastClient: humanAfterLast === 1,
      }
      const isBought = firstOrderAt !== null
      const group = humanAfter ? conversion.human : botAfter ? conversion.botOnly : conversion.noReply
      group.leads++
      if (isBought) {
        group.bought++
        conversion.bought++
      }

      const bucket = buckets.get(classifyClient(facts))
      if (!bucket) continue
      bucket.count++
      if (bucket.rows.length < LIST_LIMIT) {
        bucket.rows.push({
          chatId, name: null, dealId: null, totalMsgs, msgsBeforeOrder,
          msToOrder: firstOrderAt === null ? null : firstOrderAt - firstDialogAt,
        })
      }
    }

    const listed = [...buckets.values()].flatMap((b) => b.rows)
    if (listed.length > 0) {
      const names = await rpc<Record<string, { name: string | null; dealId: string | null }>>(
        'analytics_chat_names', { p_chat_ids: listed.map((r) => r.chatId) }
      )
      for (const row of listed) {
        row.name = names[row.chatId]?.name ?? null
        row.dealId = names[row.chatId]?.dealId ?? null
      }
    }

    return {
      range,
      generatedAt: new Date().toISOString(),
      dataSince: raw.dataSince,
      wrote: raw.wrote,
      newLeads: raw.newLeads,
      human: raw.human,
      botOnly: raw.botOnly,
      noReply: raw.noReply,
      waitingTotal: raw.waitingTotal,
      waiting: raw.waiting,
      conversion,
      types: CLIENT_TYPE_ORDER.map((type) => {
        const b = buckets.get(type) ?? { count: 0, rows: [] }
        return { type, count: b.count, clients: b.rows }
      }),
    }
  })
}

// ─── Покупки ────────────────────────────────────────────────────────────────

export interface PurchasesAnalytics {
  range: PeriodRange
  generatedAt: string
  orders: number
  boxes: number
  noQuantity: number
  revenue: number
  withAmount: number
  noAmount: number
  noPhone: number
  buyers: number
  repeatBuyers: number
  cities: { city: string; orders: number }[]
  daily: { day: string; orders: number; revenue: number }[]
}

export async function loadPurchases(range: PeriodRange): Promise<PurchasesAnalytics> {
  return cached(`purchases:${range.fromIso}:${range.toIso}`, async () => {
    const raw = await rpc<Omit<PurchasesAnalytics, 'range' | 'generatedAt'>>('analytics_purchases', rangeArgs(range))
    return {
      ...raw,
      revenue: Number(raw.revenue),
      daily: raw.daily.map((d) => ({ ...d, revenue: Number(d.revenue) })),
      range,
      generatedAt: new Date().toISOString(),
    }
  })
}

// ─── Сотрудники ─────────────────────────────────────────────────────────────

export interface StaffWork {
  leads: number
  answered: number
  boughtAfterAnswer: number
  orders: number
  revenue: number
  ordersNoAmount: number
  unanswered: ChatRef[]
}

export interface StaffRow extends StaffWork {
  hours: StaffHours
}

export interface StaffAnalytics {
  range: PeriodRange
  generatedAt: string
  staff: StaffRow[]
  offShift: StaffWork & { unansweredTotal: number }
}

interface StaffRpc {
  shifts: { staffId: string; name: string; mode: string; from: string; to: string }[]
  staff: (StaffWork & { staffId: string })[]
  offShift: StaffWork & { unansweredTotal: number }
}

export async function loadStaff(range: PeriodRange): Promise<StaffAnalytics> {
  return cached(`staff:${range.fromIso}:${range.toIso}`, async () => {
    const raw = await rpc<StaffRpc>('analytics_staff', rangeArgs(range))
    const hours = computeStaffHours(raw.shifts.map((s) => ({
      staffId: s.staffId, name: s.name, from: Date.parse(s.from), to: Date.parse(s.to),
    })))
    const staff = hours
      .map((h) => {
        const work = raw.staff.find((s) => s.staffId === h.staffId)
        return {
          hours: h,
          leads: work?.leads ?? 0,
          answered: work?.answered ?? 0,
          boughtAfterAnswer: work?.boughtAfterAnswer ?? 0,
          orders: work?.orders ?? 0,
          revenue: Number(work?.revenue ?? 0),
          ordersNoAmount: work?.ordersNoAmount ?? 0,
          unanswered: work?.unanswered ?? [],
        }
      })
      .sort((a, b) => b.hours.totalMs - a.hours.totalMs)
    return {
      range,
      generatedAt: new Date().toISOString(),
      staff,
      offShift: { ...raw.offShift, revenue: Number(raw.offShift.revenue) },
    }
  })
}

// ─── Бот и передача менеджеру (049) ─────────────────────────────────────────

export interface BotHandoffAnalytics {
  range: PeriodRange
  generatedAt: string
  wrote: number
  handedOff: number
  handedAnswered: number
  handedWaiting: number
  handedBought: number
  handoffMedianMin: number | null
  handoffOver15: number
  handoffOver60: number
  botOnly: number
  botOnlyBought: number
  /** Сколько разных чатов получили служебную метку бота в периоде, по виду метки. */
  steps: Record<string, number>
  qrSent: number
  speed: {
    botMedianMin: number | null
    botAnswered: number
    humanMedianMin: number | null
    humanAnswered: number
    firstReplyOver15: number
    noReplyAtAll: number
  }
  waiting: (ChatRef & { handedAt: string })[]
}

export async function loadBotHandoff(range: PeriodRange): Promise<BotHandoffAnalytics> {
  return cached(`bot:${range.fromIso}:${range.toIso}`, async () => {
    const raw = await rpc<Omit<BotHandoffAnalytics, 'range' | 'generatedAt'>>('analytics_bot', rangeArgs(range))
    return { ...raw, range, generatedAt: new Date().toISOString() }
  })
}

// ─── Воронка сделок ─────────────────────────────────────────────────────────

export interface FunnelAnalytics {
  range: PeriodRange
  deals: number
  stages: { name: string; kind: string; isDefault: boolean; reached: number; now: number }[]
  sources: { source: string; deals: number }[]
  cities: { city: string; deals: number }[]
}

export async function loadFunnel(range: PeriodRange): Promise<FunnelAnalytics> {
  return cached(`funnel:${range.fromIso}:${range.toIso}`, async () => {
    const raw = await rpc<Omit<FunnelAnalytics, 'range'>>('analytics_funnel', rangeArgs(range))
    return { ...raw, range }
  })
}

// ─── Рассылки ───────────────────────────────────────────────────────────────

export interface CampaignStat {
  id: string
  title: string
  status: string
  at: string
  recipients: number
  sent: number
  failed: number
  skipped: number
  pending: number
  replied: number
  bought: number
}

export async function loadCampaigns(range: PeriodRange): Promise<{ range: PeriodRange; campaigns: CampaignStat[] }> {
  return cached(`campaigns:${range.fromIso}:${range.toIso}`, async () => ({
    range,
    campaigns: await rpc<CampaignStat[]>('analytics_campaigns', rangeArgs(range)),
  }))
}

// ─── Почти купили (053) ─────────────────────────────────────────────────────

export type ReadySignal = 'qr' | 'cod' | 'ready'

export interface AlmostRow extends ChatRef {
  qrAt: string | null
  codAt: string | null
  readyAt: string | null
  lastSignalAt: string
  /** Кто написал последним: клиент, человек, бот; null — сообщений диалога нет. */
  lastBy: 'c' | 'h' | 'b' | null
  lastMsgAt: string | null
}

export interface AlmostBoughtAnalytics {
  range: PeriodRange
  generatedAt: string
  /** Клиентов (номеров) с сигналом готовности в периоде. */
  signaled: number
  /** Из них заказали после первого сигнала. */
  bought: number
  almost: number
  byKind: Record<ReadySignal, number>
  signaledByKind: Record<ReadySignal, number>
  rows: AlmostRow[]
}

export async function loadAlmostBought(range: PeriodRange): Promise<AlmostBoughtAnalytics> {
  return cached(`almost:${range.fromIso}:${range.toIso}`, async () => {
    const raw = await rpc<Omit<AlmostBoughtAnalytics, 'range' | 'generatedAt'>>('analytics_almost_bought', rangeArgs(range))
    return { ...raw, range, generatedAt: new Date().toISOString() }
  })
}

// ─── Воронка бота по новым лидам (054) ──────────────────────────────────────

export interface BotFunnelAnalytics extends BotFunnel {
  range: PeriodRange
  generatedAt: string
}

export async function loadBotFunnel(range: PeriodRange): Promise<BotFunnelAnalytics> {
  return cached(`botfunnel:${range.fromIso}:${range.toIso}`, async () => {
    const raw = await rpc<{ leads: number; masks: Record<string, number> }>('analytics_bot_lead_funnel', rangeArgs(range))
    return { ...buildBotFunnel(raw.leads, raw.masks), range, generatedAt: new Date().toISOString() }
  })
}

// ─── Скидки (056) ───────────────────────────────────────────────────────────

export interface BoughtGroup {
  clients: number
  bought: number
}

export interface DiscountAnalytics {
  range: PeriodRange
  generatedAt: string
  d13: BoughtGroup
  d20: BoughtGroup
  anyDiscount: BoughtGroup
  newNoDiscount: BoughtGroup
  newDiscount: BoughtGroup
}

export async function loadDiscounts(range: PeriodRange): Promise<DiscountAnalytics> {
  return cached(`discounts:${range.fromIso}:${range.toIso}`, async () => {
    const raw = await rpc<Omit<DiscountAnalytics, 'range' | 'generatedAt'>>('analytics_discounts', rangeArgs(range))
    return { ...raw, range, generatedAt: new Date().toISOString() }
  })
}

// ─── Реклама или остальные (057) ────────────────────────────────────────────

export interface AdSourceAnalytics {
  range: PeriodRange
  generatedAt: string
  ad: BoughtGroup
  other: BoughtGroup
  otherTop: { text: string; clients: number }[]
}

export async function loadAdSource(range: PeriodRange): Promise<AdSourceAnalytics> {
  return cached(`adsource:${range.fromIso}:${range.toIso}`, async () => {
    const raw = await rpc<Omit<AdSourceAnalytics, 'range' | 'generatedAt'>>('analytics_ad_source', rangeArgs(range))
    return { ...raw, range, generatedAt: new Date().toISOString() }
  })
}

// ─── Города из переписки (058) ──────────────────────────────────────────────

export interface CityRow extends BoughtGroup {
  city: string
  country: Country
}

export interface CitiesAnalytics {
  range: PeriodRange
  generatedAt: string
  /** Бот спросил город в периоде. */
  asked: number
  /** Клиент ответил после вопроса. */
  answered: number
  cities: CityRow[]
  unrecognized: BoughtGroup & { examples: { text: string; clients: number }[] }
  noAnswer: BoughtGroup
}

export async function loadCities(range: PeriodRange): Promise<CitiesAnalytics> {
  return cached(`cities:${range.fromIso}:${range.toIso}`, async () => {
    const rows = await rpc<[string, string | null, 0 | 1][]>('analytics_city_answers', rangeArgs(range))
    const byCity = new Map<string, CityRow>()
    const unrecognized = { clients: 0, bought: 0 }
    const noAnswer = { clients: 0, bought: 0 }
    const examples = new Map<string, number>()
    for (const [, text, bought] of rows) {
      if (text === null) {
        noAnswer.clients++
        noAnswer.bought += bought
        continue
      }
      const match = detectCity(text)
      if (!match) {
        unrecognized.clients++
        unrecognized.bought += bought
        const key = text.replace(/\s+/g, ' ').trim().slice(0, 60) || '(пусто)'
        examples.set(key, (examples.get(key) ?? 0) + 1)
        continue
      }
      const row = byCity.get(match.city) ?? { ...match, clients: 0, bought: 0 }
      row.clients++
      row.bought += bought
      byCity.set(match.city, row)
    }
    return {
      range,
      generatedAt: new Date().toISOString(),
      asked: rows.length,
      answered: rows.length - noAnswer.clients,
      cities: [...byCity.values()].sort((a, b) => b.clients - a.clients || a.city.localeCompare(b.city, 'ru')),
      unrecognized: {
        ...unrecognized,
        examples: [...examples.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
          .slice(0, 12)
          .map(([text, clients]) => ({ text, clients })),
      },
      noAnswer,
    }
  })
}

// ─── Вернувшиеся клиенты (059) ──────────────────────────────────────────────

export interface ReturningAnalytics {
  range: PeriodRange
  generatedAt: string
  wrote: number
  returned: number
  afterCampaign: BoughtGroup
  self: BoughtGroup
}

export async function loadReturning(range: PeriodRange): Promise<ReturningAnalytics> {
  return cached(`returning:${range.fromIso}:${range.toIso}`, async () => {
    const raw = await rpc<Omit<ReturningAnalytics, 'range' | 'generatedAt'>>('analytics_returning', rangeArgs(range))
    return { ...raw, range, generatedAt: new Date().toISOString() }
  })
}

// ─── Нагрузка по часам (055) ────────────────────────────────────────────────

export interface LoadHour {
  hour: number
  clients: number
  botMedianMin: number | null
  botAnswered: number
  humanMedianMin: number | null
  humanAnswered: number
  over15: number
}

export interface LoadAnalytics {
  range: PeriodRange
  generatedAt: string
  /** [день недели 1=пн…7=вс, час, разных клиентов] */
  heat: [number, number, number][]
  hours: LoadHour[]
}

type LoadHourTuple = [number, number, number | null, number, number | null, number, number]

export async function loadLoad(range: PeriodRange): Promise<LoadAnalytics> {
  return cached(`load:${range.fromIso}:${range.toIso}`, async () => {
    const raw = await rpc<{ heat: [number, number, number][]; hours: LoadHourTuple[] }>('analytics_load', rangeArgs(range))
    return {
      range,
      generatedAt: new Date().toISOString(),
      heat: raw.heat,
      hours: raw.hours.map(([hour, clients, botMedianMin, botAnswered, humanMedianMin, humanAnswered, over15]) => ({
        hour, clients, botMedianMin, botAnswered, humanMedianMin, humanAnswered, over15,
      })),
    }
  })
}
