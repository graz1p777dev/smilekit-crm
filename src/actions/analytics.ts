'use server'

// Аналитика конверсий: продажи, диалоги и кто их ведёт — бот или менеджер.
// Считаем из того, что реально лежит в базе:
//   orders              — продажи (коробки, выручка, чек);
//   chat_messages     — переписка WhatsApp (amoCRM + Green API);
//   whatsapp_messages   — переписка Wazzup;
//   instagram_messages  — переписка Instagram;
//   deals.source        — Telegram и витрина: их переписка живёт в боте
//                         витрины, в CRM её нет, поэтому там один диалог —
//                         это одна сделка.
// Через admin-клиент: instagram_messages по RLS видит только owner, а
// цифра нужна и РОПу.

import { createAdminClient } from '@/lib/supabase/admin'
import { isFailure, requireManagement } from '@/lib/auth-guards'

export type AnalyticsPeriod = 'today' | 'month' | 'year'

export interface PeriodStats {
  orders: number
  boxes: number
  revenue: number
  avgCheck: number
  buyers: number
  dialogs: number
  /** Доля диалогов, дошедших до заказа, %. */
  conversion: number
  dialogsByBot: number
  dialogsByManager: number
}

export interface ChannelStats {
  label: string
  dialogs: number
  orders: number
  conversion: number
}

export interface ManagerLoad {
  name: string
  dialogs: number
}

/** Сколько РАЗНЫХ людей пришло из города (не заказов — людей). */
export interface CityClients {
  city: string
  clients: number
  orders: number
  revenue: number
}

/**
 * «Железный» клиент — тот, кто ни разу не покупал со скидкой: все его
 * заказы по полной цене. Как только человек взял хоть одну коробку дешевле,
 * он переходит в обычные.
 */
export interface ClientQuality {
  iron: number
  discounted: number
  /** Доля железных, %. */
  ironShare: number
}

/** Сколько заказов ушло по каждой ступени цены. */
export interface DiscountTier {
  label: string
  orders: number
  /** Недополученная выручка против полной цены. */
  givenAway: number
}

export interface RepeatSales {
  /** Заказы, которые у клиента не первые. */
  repeatOrders: number
  /** Выручка с повторных заказов. */
  repeatRevenue: number
  /** Клиентов, купивших больше одного раза. */
  repeatClients: number
  /** Доля повторных заказов от всех, %. */
  share: number
}

/** Точка дневной динамики. */
export interface DayPoint {
  date: string
  revenue: number
  orders: number
}

export interface ConversionAnalytics {
  today: PeriodStats
  month: PeriodStats
  year: PeriodStats
  /** Разрез по каналам за текущий год. */
  channels: ChannelStats[]
  /** Кто из менеджеров сколько диалогов забрал себе за текущий год. */
  managers: ManagerLoad[]
  /** Люди по городам — за всё время. */
  cities: CityClients[]
  clientQuality: ClientQuality
  discountTiers: DiscountTier[]
  repeat: RepeatSales
  /** Последние 30 дней. */
  daily: DayPoint[]
}

// Asia/Bishkek — круглый год UTC+6, перевода часов нет.
const BISHKEK_OFFSET_MS = 6 * 3600_000

function periodStart(kind: AnalyticsPeriod): Date {
  const local = new Date(Date.now() + BISHKEK_OFFSET_MS)
  const y = local.getUTCFullYear()
  const m = local.getUTCMonth()
  const d = local.getUTCDate()
  const startLocal =
    kind === 'today' ? Date.UTC(y, m, d) : kind === 'month' ? Date.UTC(y, m, 1) : Date.UTC(y, 0, 1)
  return new Date(startLocal - BISHKEK_OFFSET_MS)
}

/**
 * PostgREST молча режет выборку до 1000 строк (project max-rows) — та же
 * ловушка, что в рассылках и на доске сделок. Читаем постранично.
 */
async function fetchAllRows<T>(
  admin: ReturnType<typeof createAdminClient>,
  table: string,
  select: string,
  // Тот же приём, что в src/actions/campaigns.ts: типов билдера PostgREST
  // здесь нет, пока не сгенерированы типы БД.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply: (query: any) => any
): Promise<T[]> {
  const PAGE_SIZE = 1000
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await apply(admin.from(table).select(select)).range(from, from + PAGE_SIZE - 1)
    if (error) {
      // Не все миграции применены на каждом стенде: instagram_messages,
      // например, в проде ещё нет. Отсутствие таблицы — это «данных по
      // каналу нет», а не повод обрушить всю страницу аналитики: без
      // этой ветки весь дашборд падал с React error #441.
      if (isMissingTable(error)) return []
      throw new Error(`${table}: ${error.message}`)
    }
    rows.push(...((data ?? []) as T[]))
    if (!data || data.length < PAGE_SIZE) break
  }
  return rows
}

/** PostgREST на неизвестную таблицу отвечает кодом PGRST205. */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST205'
    || (error.message ?? '').includes('Could not find the table')
}

interface OrderRow {
  customer_phone: string | null
  quantity: number | null
  total_amount: number | null
  status: string
  city: string | null
  external_key: string | null
  created_at: string
}

/** Телефон сводим к последним 9 цифрам — формат номера в базе разный. */
const personKey = (phone: string | null | undefined) => {
  const digits = String(phone ?? '').replace(/\D/g, '')
  return digits ? digits.slice(-9) : ''
}

/** Цена за коробку — по ней видно, была скидка или нет. */
const PRICE_FULL = 1490
function pricePerBox(order: OrderRow): number | null {
  if (order.total_amount === null || !order.quantity) return null
  return Math.round(Number(order.total_amount) / order.quantity)
}

/** Ступени из базы знаний бота: 1490 без скидки, затем 1290 и 1190. */
function discountLabel(perBox: number): string {
  if (perBox >= 1450) return 'Без скидки — 1490'
  if (perBox >= 1250) return 'Скидка 13% — 1290'
  if (perBox >= 1150) return 'Скидка 20% — 1190'
  return `Ниже прайса — ${perBox.toLocaleString('ru-RU')}`
}

/** Один диалог: когда начался, по какому каналу и кто в нём отвечал. */
interface Dialog {
  key: string
  channel: string
  startedAt: string
  managerNames: Set<string>
}

const LAB_CHAT = /^lab[-:]/i

function orderChannel(externalKey: string | null): string {
  const prefix = externalKey?.split(':')[0]
  if (prefix === 'telegram') return 'Telegram'
  if (prefix === 'greenapi' || prefix === 'amocrm') return 'WhatsApp'
  if (prefix === 'instagram') return 'Instagram'
  return 'Другое'
}

function dealChannel(source: string): string | null {
  if (source === 'telegram') return 'Telegram'
  if (source === 'site') return 'Витрина'
  return null
}

function emptyStats(): PeriodStats {
  return {
    orders: 0, boxes: 0, revenue: 0, avgCheck: 0, buyers: 0,
    dialogs: 0, conversion: 0, dialogsByBot: 0, dialogsByManager: 0,
  }
}

function statsFor(orders: OrderRow[], dialogs: Dialog[], since: Date): PeriodStats {
  const sinceIso = since.toISOString()
  const stats = emptyStats()
  const buyers = new Set<string>()
  let paidOrders = 0

  for (const order of orders) {
    if (order.created_at < sinceIso) continue
    stats.orders++
    stats.boxes += order.quantity ?? 0
    if (order.total_amount !== null) {
      stats.revenue += Number(order.total_amount)
      paidOrders++
    }
    const phone = order.customer_phone?.replace(/\D/g, '')
    if (phone) buyers.add(phone)
  }
  stats.buyers = buyers.size
  stats.avgCheck = paidOrders ? Math.round(stats.revenue / paidOrders) : 0

  for (const dialog of dialogs) {
    if (dialog.startedAt < sinceIso) continue
    stats.dialogs++
    if (dialog.managerNames.size > 0) stats.dialogsByManager++
    else stats.dialogsByBot++
  }
  stats.conversion = stats.dialogs ? Math.round((stats.orders / stats.dialogs) * 100) : 0
  return stats
}

/**
 * Перебор переписки за год стоит секунд, а цифры за это время не меняются
 * ощутимо. Держим последний результат 5 минут: повторные заходы и
 * переключение вкладок отдаются мгновенно.
 */
let cached: { at: number; data: ConversionAnalytics } | null = null
const CACHE_TTL_MS = 5 * 60_000


// ─── Разрезы по клиентам ─────────────────────────────────────────────────────

/**
 * Люди по городам. Считаем именно ЛЮДЕЙ, а не заказы: один клиент может
 * заказать трижды, и в разрезе «откуда наши клиенты» это всё равно один
 * человек. Город берём из заказа, а если его там нет — из сделки клиента.
 */
function cityClients(
  orders: OrderRow[],
  deals: { customer_phone: string | null; city: string | null }[]
): CityClients[] {
  const cityByPerson = new Map<string, string>()
  for (const deal of deals) {
    const person = personKey(deal.customer_phone)
    const city = deal.city?.trim()
    if (person && city) cityByPerson.set(person, city)
  }

  const stats = new Map<string, { people: Set<string>; orders: number; revenue: number }>()
  const bucket = (city: string) => {
    const existing = stats.get(city)
    if (existing) return existing
    const fresh = { people: new Set<string>(), orders: 0, revenue: 0 }
    stats.set(city, fresh)
    return fresh
  }

  for (const order of orders) {
    const person = personKey(order.customer_phone)
    const city = order.city?.trim() || (person ? cityByPerson.get(person) : null) || 'Не указан'
    const entry = bucket(city)
    entry.orders++
    entry.revenue += Number(order.total_amount ?? 0)
    if (person) entry.people.add(person)
  }
  // Клиенты, которые только написали и ещё не купили, но город назвали.
  for (const [person, city] of cityByPerson) {
    bucket(city).people.add(person)
  }

  return [...stats.entries()]
    .map(([city, entry]) => ({ city, clients: entry.people.size, orders: entry.orders, revenue: entry.revenue }))
    .sort((a, b) => b.clients - a.clients)
}

/** Железные (ни одной скидки) против тех, кто хоть раз покупал дешевле. */
function clientQuality(orders: OrderRow[]): ClientQuality {
  const discounted = new Set<string>()
  const all = new Set<string>()
  for (const order of orders) {
    const person = personKey(order.customer_phone)
    if (!person) continue
    all.add(person)
    const perBox = pricePerBox(order)
    if (perBox !== null && perBox < 1450) discounted.add(person)
  }
  const iron = all.size - discounted.size
  return {
    iron,
    discounted: discounted.size,
    ironShare: all.size ? Math.round((iron / all.size) * 100) : 0,
  }
}

/** Сколько заказов по каждой ступени цены и сколько на этом отдано. */
function discountTiers(orders: OrderRow[]): DiscountTier[] {
  const tiers = new Map<string, DiscountTier>()
  for (const order of orders) {
    const perBox = pricePerBox(order)
    if (perBox === null) continue
    const label = discountLabel(perBox)
    const entry = tiers.get(label) ?? { label, orders: 0, givenAway: 0 }
    entry.orders++
    entry.givenAway += Math.max(0, PRICE_FULL - perBox) * (order.quantity ?? 0)
    tiers.set(label, entry)
  }
  return [...tiers.values()].sort((a, b) => b.orders - a.orders)
}

/** Повторные продажи: заказы, которые у клиента не первые. */
function repeatSales(orders: OrderRow[]): RepeatSales {
  const byPerson = new Map<string, OrderRow[]>()
  for (const order of orders) {
    const person = personKey(order.customer_phone)
    if (!person) continue
    const list = byPerson.get(person) ?? []
    list.push(order)
    byPerson.set(person, list)
  }

  let repeatOrders = 0
  let repeatRevenue = 0
  let repeatClients = 0
  for (const list of byPerson.values()) {
    if (list.length < 2) continue
    repeatClients++
    const sorted = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at))
    for (const order of sorted.slice(1)) {
      repeatOrders++
      repeatRevenue += Number(order.total_amount ?? 0)
    }
  }
  const total = orders.length
  return {
    repeatOrders,
    repeatRevenue,
    repeatClients,
    share: total ? Math.round((repeatOrders / total) * 100) : 0,
  }
}

/** Выручка и заказы по дням за последние 30 суток. */
function dailySeries(orders: OrderRow[]): DayPoint[] {
  const DAYS = 30
  const days = new Map<string, DayPoint>()
  const today = new Date(Date.now() + BISHKEK_OFFSET_MS)
  for (let i = DAYS - 1; i >= 0; i--) {
    const day = new Date(today.getTime() - i * 86400_000)
    const key = day.toISOString().slice(0, 10)
    days.set(key, { date: key, revenue: 0, orders: 0 })
  }
  for (const order of orders) {
    const key = new Date(new Date(order.created_at).getTime() + BISHKEK_OFFSET_MS)
      .toISOString().slice(0, 10)
    const point = days.get(key)
    if (!point) continue
    point.orders++
    point.revenue += Number(order.total_amount ?? 0)
  }
  return [...days.values()]
}

export async function getConversionAnalytics(): Promise<ConversionAnalytics> {
  // Скрытый пункт меню — не защита: server action вызывается напрямую.
  // Здесь вся выручка, скидки и нагрузка менеджеров, читаемые admin-клиентом
  // в обход RLS, поэтому роль проверяем явно.
  const guard = await requireManagement()
  if (isFailure(guard)) throw new Error(guard.error)

  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data

  const admin = createAdminClient()
  const yearStart = periodStart('year')
  const yearIso = yearStart.toISOString()

  const [orders, amoMessages, wazzupMessages, instaMessages, deals, employees] = await Promise.all([
    fetchAllRows<OrderRow>(
      admin, 'orders',
      'customer_phone, quantity, total_amount, status, city, external_key, created_at',
      (q) => q.neq('status', 'cancelled').is('deleted_at', null).order('created_at')
    ),
    fetchAllRows<{ chat_id: string; sender: string; author_name: string | null; created_at: string }>(
      admin, 'chat_messages', 'chat_id, sender, author_name, created_at',
      (q) => q.gte('created_at', yearIso).order('id')
    ),
    fetchAllRows<{ phone: string; direction: string; sent_by: string | null; created_at: string }>(
      admin, 'whatsapp_messages', 'phone, direction, sent_by, created_at',
      (q) => q.gte('created_at', yearIso).order('created_at')
    ),
    fetchAllRows<{ sender_igsid: string; created_at: string }>(
      admin, 'instagram_messages', 'sender_igsid, created_at',
      (q) => q.gte('created_at', yearIso).order('created_at')
    ),
    fetchAllRows<{ id: string; source: string; created_at: string; customer_phone: string | null; city: string | null }>(
      admin, 'deals', 'id, source, created_at, customer_phone, city',
      (q) => q.gte('created_at', yearIso).is('deleted_at', null).order('id')
    ),
    fetchAllRows<{ id: string; name: string }>(
      admin, 'employees', 'id, name',
      (q) => q.is('deleted_at', null).order('name')
    ),
  ])

  const employeeNames = new Map(employees.map((e) => [e.id, e.name]))
  const dialogMap = new Map<string, Dialog>()

  const touch = (key: string, channel: string, createdAt: string, manager: string | null) => {
    const existing = dialogMap.get(key)
    if (!existing) {
      dialogMap.set(key, {
        key, channel, startedAt: createdAt,
        managerNames: new Set(manager ? [manager] : []),
      })
      return
    }
    if (createdAt < existing.startedAt) existing.startedAt = createdAt
    if (manager) existing.managerNames.add(manager)
  }

  for (const m of amoMessages) {
    // Лабораторные чаты (чат-песочница WhatsApp) — не клиенты.
    if (LAB_CHAT.test(m.chat_id)) continue
    touch(
      `amo:${m.chat_id}`, 'WhatsApp', m.created_at,
      m.sender === 'operator' ? (m.author_name?.trim() || 'Менеджер') : null
    )
  }
  for (const m of wazzupMessages) {
    touch(
      `wz:${m.phone.replace(/\D/g, '')}`, 'WhatsApp', m.created_at,
      m.direction === 'out' && m.sent_by ? (employeeNames.get(m.sent_by) ?? 'Менеджер') : null
    )
  }
  for (const m of instaMessages) {
    touch(`ig:${m.sender_igsid}`, 'Instagram', m.created_at, null)
  }
  for (const deal of deals) {
    const channel = dealChannel(deal.source)
    // Диалог считаем по сделке только для каналов без своей таблицы
    // переписки — иначе WhatsApp-клиент посчитался бы дважды.
    if (channel) touch(`deal:${deal.id}`, channel, deal.created_at, null)
  }

  const dialogs = [...dialogMap.values()]

  // Каналы — за год: диалоги из dialogs, заказы по external_key.
  const channelMap = new Map<string, ChannelStats>()
  const channelOf = (label: string) => {
    const existing = channelMap.get(label)
    if (existing) return existing
    const fresh: ChannelStats = { label, dialogs: 0, orders: 0, conversion: 0 }
    channelMap.set(label, fresh)
    return fresh
  }
  for (const dialog of dialogs) channelOf(dialog.channel).dialogs++
  for (const order of orders) {
    if (order.created_at < yearIso) continue
    channelOf(orderChannel(order.external_key)).orders++
  }
  const channels = [...channelMap.values()]
    .map((c) => ({ ...c, conversion: c.dialogs ? Math.round((c.orders / c.dialogs) * 100) : 0 }))
    .sort((a, b) => b.dialogs - a.dialogs)

  const managerMap = new Map<string, number>()
  for (const dialog of dialogs) {
    for (const name of dialog.managerNames) {
      managerMap.set(name, (managerMap.get(name) ?? 0) + 1)
    }
  }
  const managers = [...managerMap.entries()]
    .map(([name, count]) => ({ name, dialogs: count }))
    .sort((a, b) => b.dialogs - a.dialogs)

  const result: ConversionAnalytics = {
    today: statsFor(orders, dialogs, periodStart('today')),
    month: statsFor(orders, dialogs, periodStart('month')),
    year: statsFor(orders, dialogs, yearStart),
    channels,
    managers,
    cities: cityClients(orders, deals),
    clientQuality: clientQuality(orders),
    discountTiers: discountTiers(orders),
    repeat: repeatSales(orders),
    daily: dailySeries(orders),
  }
  cached = { at: Date.now(), data: result }
  return result
}
