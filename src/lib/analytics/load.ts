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
