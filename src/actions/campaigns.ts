'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { voiceById } from '@/config/voice-messages'

export interface CampaignRow {
  id: string
  title: string
  /** null — рассылка голосовая, текста у неё нет. */
  message: string | null
  /** id из src/config/voice-messages.ts, если рассылка голосовая. */
  voice_id: string | null
  /** Заполнено — рассылку создало правило автоматической рассылки. */
  recurring_id: string | null
  /** Имя того, кто её завёл (или чьё правило её создало). */
  author: string | null
  scheduled_at: string
  status: 'scheduled' | 'running' | 'completed' | 'cancelled' | 'failed'
  recipient_count: number
  sent_count: number
  failed_count: number
  created_at: string
}

export interface CampaignsData {
  campaigns: CampaignRow[]
  recurring: RecurringCampaignRow[]
  /** null — ещё не посчитано: число едет отдельным запросом с клиента. */
  eligibleCount: number | null
  optOuts: OptOutRow[]
}

type Recipient = {
  deal_id: string
  channel: 'telegram' | 'whatsapp' | 'instagram'
  external_key: string
  chat_id: string
  lead_id: string | null
  contact_id: string | null
}

async function viewer() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  const { data } = await supabase
    .from('employees')
    .select('id, role')
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .maybeSingle()
  return data as { id: string; role: string } | null
}

/** Только цифры — так же нормализован campaign_opt_outs.phone и телефон в чеке. */
function normalizePhone(value: string | null | undefined): string {
  return String(value || '').replace(/\D/g, '')
}

/**
 * Supabase (PostgREST) молча обрезает любую выборку до 1000 строк — сервер
 * игнорирует .limit() больше этого потолка (project max-rows), проверено
 * напрямую: .limit(100000) всё равно вернул ровно 1000. С 6750+ строками в
 * chat_messages и почти 1000 сделками это тихо теряло данные —
 * eligibleRecipients() почти всех клиентов отсеивал как «нет данных».
 * Обходим постраничным чтением через .range().
 */
async function fetchAllRows<T>(
  admin: ReturnType<typeof createAdminClient>,
  table: string,
  select: string,
  apply: (query: any) => any
): Promise<T[]> {
  const PAGE_SIZE = 1000
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await apply(admin.from(table).select(select)).range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...((data ?? []) as T[]))
    if (!data || data.length < PAGE_SIZE) break
  }
  return rows
}

export interface LastMessageDateFilter {
  /** ISO-даты (включительно), фильтр по последнему сообщению КЛИЕНТА в чате. */
  from?: string
  to?: string
}

/** Кого включать в рассылку по признаку покупки. */
export type CampaignAudience = 'not_purchased' | 'purchased' | 'all'

export interface AudienceFilter extends LastMessageDateFilter {
  audience?: CampaignAudience
}

/**
 * Тот же подбор получателей, но для запуска БЕЗ пользователя — из
 * планировщика автоматических рассылок. Права проверены в момент создания
 * правила, здесь проверять нечего и некого.
 */
export async function eligibleRecipientsForRun(filter?: AudienceFilter): Promise<Recipient[]> {
  return eligibleRecipients(filter)
}

async function eligibleRecipients(filter?: AudienceFilter): Promise<Recipient[]> {
  const admin = createAdminClient()
  const audience: CampaignAudience = filter?.audience ?? 'not_purchased'
  const dateFilter = filter
  // Канал один — Green API, он адресуется НОМЕРОМ. Поэтому:
  //   * chat_id в переписке для живых чатов и есть номер;
  //   * amojo-адресация (chat_id вида UUID) больше не нужна.
  const greenApiReady = Boolean(process.env.GREENAPI_ID_INSTANCE && process.env.GREENAPI_API_TOKEN_INSTANCE)

  // Даты приходят как «2026-09-14» и означают СУТКИ ПО БИШКЕКУ, а не момент.
  // Раньше их разбирал голый new Date('2026-09-14') — это полночь UTC, то
  // есть 06:00 утра по Бишкеку. Диапазон «сегодня — сегодня» превращался в
  // одну точку в прошлом, и под фильтр не попадал никто из написавших днём.
  const BISHKEK = '+06:00'
  const dayStart = (day: string) => new Date(`${day}T00:00:00${BISHKEK}`)
  const dayEnd = (day: string) => new Date(`${day}T23:59:59.999${BISHKEK}`)

  // Граница бывает двух видов:
  //   «2026-09-17»              — сутки по Бишкеку целиком (кнопки «за N дней»);
  //   «2026-09-17T12:29:05.000Z» — точный момент («за сутки», «с прошлой рассылки»).
  // Для точного момента нельзя расширять до целых суток, иначе «с прошлой
  // рассылки» захватит людей, которые её уже получили.
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
  const lowerBound = (value: string) => DATE_ONLY.test(value) ? dayStart(value) : new Date(value)
  const upperBound = (value: string) => DATE_ONLY.test(value) ? dayEnd(value) : new Date(value)

  const fromDate = dateFilter?.from ? lowerBound(dateFilter.from) : null
  const toDate = dateFilter?.to ? upperBound(dateFilter.to) : null
  if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
    return []
  }
  const fromTime = fromDate ? fromDate.getTime() : null
  const toTime = toDate ? toDate.getTime() : null

  const [deals, { data: orders }, operatorRows, { data: optOuts }, chatControls] = await Promise.all([
    fetchAllRows<{ id: string; source: string; external_key: string | null; customer_phone: string | null }>(
      admin, 'deals', 'id, source, external_key, customer_phone',
      (q) => (audience === 'all' ? q : q.neq('status', 'won')).is('deleted_at', null).order('id')
    ),
    admin
      .from('orders')
      .select('deal_id')
      .neq('status', 'cancelled')
      .is('deleted_at', null),
    // ТОЛЬКО сообщения менеджеров. Раньше здесь вычитывалась вся таблица
    // переписки целиком (десятки тысяч строк, постранично по 1000) — ради
    // двух производных величин. Именно это подвешивало страницу рассылок:
    // в логах прода «The destination stream closed early».
    fetchAllRows<{ chat_id: string; created_at: string }>(
      admin, 'chat_messages', 'chat_id, created_at',
      (q) => q.eq('sender', 'operator').order('id', { ascending: false })
    ),
    admin.from('campaign_opt_outs').select('phone'),
    fetchAllRows<{ chat_id: string; bot_enabled: boolean; updated_at: string }>(
      admin, 'chat_control', 'chat_id, bot_enabled, updated_at', (q) => q.order('chat_id')
    ),
  ])

  const purchased = new Set((orders ?? []).flatMap((row) => row.deal_id ? [String(row.deal_id)] : []))
  const excludedPhones = new Set((optOuts ?? []).map((row) => row.phone as string))

  // «Менеджер ведёт чат»: явная отметка перекрывает прошлые сообщения
  // менеджера, но только до его следующего сообщения.
  const controlByChat = new Map(chatControls.map((row) => [String(row.chat_id), row]))
  const lastOperatorAtByChat = new Map<string, string>()
  for (const row of operatorRows) {
    const chatId = String(row.chat_id)
    const known = lastOperatorAtByChat.get(chatId)
    if (!known || row.created_at > known) lastOperatorAtByChat.set(chatId, row.created_at)
  }
  const managerChats = new Set(
    [...new Set([...lastOperatorAtByChat.keys(), ...controlByChat.keys()])].filter((chatId) => {
      const lastOperatorAt = lastOperatorAtByChat.get(chatId) ?? null
      const control = controlByChat.get(chatId)
      if (!control) return lastOperatorAt !== null
      const overrideIsFresh = lastOperatorAt === null
        || new Date(control.updated_at).getTime() > new Date(lastOperatorAt).getTime()
      return overrideIsFresh ? !control.bot_enabled : true
    })
  )

  // Сообщения клиентов читаем ТОЛЬКО когда задан фильтр по дате, и сразу
  // обрезаем по нижней границе. Для «кто писал сегодня» это несколько сотен
  // строк вместо всей истории.
  const lastClientAtByPhone = new Map<string, string>()
  if (fromTime || toTime) {
    const clientRows = await fetchAllRows<{ chat_id: string; created_at: string }>(
      admin, 'chat_messages', 'chat_id, created_at',
      (q) => {
        const base = q.eq('sender', 'client')
        const bounded = fromDate ? base.gte('created_at', fromDate.toISOString()) : base
        return bounded.order('id', { ascending: false })
      }
    )
    // Строки идут id DESC, поэтому первое попадание на номер — самое свежее.
    for (const row of clientRows) {
      const phone = normalizePhone(row.chat_id)
      if (phone && !lastClientAtByPhone.has(phone)) lastClientAtByPhone.set(phone, row.created_at)
    }
  }

  return (deals ?? []).flatMap((deal): Recipient[] => {
    const id = String(deal.id)
    const key = String(deal.external_key || '')
    if (!key) return []
    if (audience === 'not_purchased' && purchased.has(id)) return []
    if (audience === 'purchased' && !purchased.has(id)) return []

    const phone = normalizePhone(
      key.startsWith('greenapi:') ? key.slice('greenapi:'.length) : deal.customer_phone
    )
    if (excludedPhones.has(phone)) return []

    if (deal.source === 'telegram' && key.startsWith('telegram:')) {
      // У Telegram своя переписка в боте витрины, здесь её нет — по дате
      // отфильтровать нечем.
      if (fromTime || toTime) return []
      const chatId = key.slice('telegram:'.length)
      return /^-?\d+$/.test(chatId) ? [{
        deal_id: id,
        channel: 'telegram',
        external_key: key,
        chat_id: chatId,
        lead_id: null,
        contact_id: null,
      }] : []
    }

    // Остальное — WhatsApp через Green API, адресуем по номеру. Сюда попадают
    // и старые сделки с ключом amocrm:<lead_id>: у них номер лежит в карточке
    // клиента, а переписка — в том же chat_id по номеру.
    if (!greenApiReady || phone.length < 9) return []
    if (managerChats.has(phone)) return []

    if (fromTime || toTime) {
      // Фильтр по дате теперь работает и для сделок Green API. Раньше эта
      // ветка возвращала пусто при ЛЮБОМ диапазоне — то есть рассылка
      // «тем, кто писал сегодня» молча получала ноль получателей.
      const lastAt = lastClientAtByPhone.get(phone)
      if (!lastAt) return []
      const lastTime = new Date(lastAt).getTime()
      if (fromTime && lastTime < fromTime) return []
      if (toTime && lastTime > toTime) return []
    }

    return [{
      deal_id: id,
      channel: 'whatsapp',
      external_key: key,
      chat_id: phone,
      lead_id: key.startsWith('amocrm:') ? key.slice('amocrm:'.length) : null,
      contact_id: null,
    }]
  })
}

/**
 * Данные страницы рассылок. Здесь НЕТ подсчёта аудитории, и это принципиально.
 *
 * eligibleRecipients() вычитывает всю таблицу chat_messages (тысячи строк,
 * постранично по 1000 — то есть десяток последовательных запросов), потому что
 * ей нужно «последнее сообщение в каждом чате». Пока это стояло в рендере
 * страницы, открытие «Рассылок» ждало весь этот перебор и часто не дожидалось:
 * в логах прода — `Error: The destination stream closed early`, в браузере —
 * бесконечный логотип-загрузчик.
 *
 * Теперь страница отдаётся сразу, а число получателей клиент запрашивает
 * отдельно через getEligibleCountForRange() и показывает «считаем…», пока
 * оно едет. Тот же самый вызов уже использовался при смене фильтров.
 */
export async function getCampaignsData(): Promise<CampaignsData> {
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return { campaigns: [], eligibleCount: null, optOuts: [], recurring: [] }
  const admin = createAdminClient()
  const [{ data }, optOuts, recurring] = await Promise.all([
    admin.from('campaigns').select('*').order('created_at', { ascending: false }).limit(50),
    getOptOutPhones(),
    getRecurringCampaigns(),
  ])

  const rows = (data ?? []) as (CampaignRow & { created_by: string | null })[]
  const names = await employeeNames(
    [...new Set(rows.flatMap((row) => row.created_by ? [row.created_by] : []))]
  )

  return {
    campaigns: rows.map((row) => ({
      ...row,
      author: row.created_by ? names.get(row.created_by) ?? null : null,
    })),
    eligibleCount: null,
    optOuts,
    recurring,
  }
}

/** Живой пересчёт аудитории под выбранные фильтры (для UI, до создания рассылки). */
export async function getEligibleCountForRange(
  dateFrom?: string,
  dateTo?: string,
  audience?: CampaignAudience
): Promise<number> {
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return 0
  const recipients = await eligibleRecipients({
    from: dateFrom || undefined,
    to: dateTo || undefined,
    audience,
  })
  return recipients.length
}

const CampaignSchema = z.object({
  title: z.string().trim().min(1).max(160),
  // Пусто допустимо только для голосовой рассылки — проверка ниже, в refine:
  // у голосового свой смысл, дублировать его текстом не обязательно.
  message: z.string().trim().max(4000),
  voiceId: z.string().trim().optional(),
  scheduledAt: z.string().datetime(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  audience: z.enum(['not_purchased', 'purchased', 'all']).optional(),
}).refine(
  (data) => data.message.length > 0 || Boolean(data.voiceId),
  { message: 'Нужен текст или голосовое' }
)

export async function scheduleCampaign(input: unknown): Promise<{ success: true; count: number } | { success: false; error: string }> {
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return { success: false, error: 'Нет доступа' }
  const parsed = CampaignSchema.safeParse(input)
  if (!parsed.success) return { success: false, error: 'Заполните название, сообщение (или голосовое) и время отправки' }
  // id голосового проверяем по реестру, а не доверяем клиенту: иначе в базу
  // попадёт ссылка на несуществующий файл и рассылка молча не уйдёт.
  const voice = voiceById(parsed.data.voiceId)
  if (parsed.data.voiceId && !voice) return { success: false, error: 'Такого голосового нет' }
  const scheduledAt = new Date(parsed.data.scheduledAt)
  if (scheduledAt.getTime() < Date.now() - 60_000) return { success: false, error: 'Время отправки уже прошло' }
  const recipients = await eligibleRecipients({
    from: parsed.data.dateFrom,
    to: parsed.data.dateTo,
    audience: parsed.data.audience,
  })
  if (!recipients.length) return { success: false, error: 'Нет клиентов под выбранные фильтры' }

  const admin = createAdminClient()
  // voice_id кладём в insert ТОЛЬКО для голосовой рассылки. Колонки может
  // ещё не быть (миграция 042_campaign_voice.sql), и упоминание её имени
  // уронило бы вообще любую рассылку, включая обычную текстовую.
  const voiceColumn = voice ? { voice_id: voice.id } : {}
  const { data: campaign, error } = await admin.from('campaigns').insert({
    title: parsed.data.title,
    message: parsed.data.message || null,
    ...voiceColumn,
    scheduled_at: scheduledAt.toISOString(),
    recipient_count: recipients.length,
    created_by: me.id,
  }).select('id').single()
  if (error || !campaign) {
    // Пока миграция 042_campaign_voice.sql не применена, в базе нет ни
    // колонки voice_id, ни разрешения на пустой текст. Говорим об этом
    // прямо, а не «не удалось создать рассылку».
    const raw = error?.message ?? ''
    if (voice && (raw.includes('voice_id') || raw.includes('campaigns_message_check') || raw.includes('null value in column "message"'))) {
      return {
        success: false,
        error: 'Голосовые рассылки ещё не включены в базе: примените миграцию 042_campaign_voice.sql',
      }
    }
    return { success: false, error: raw || 'Не удалось создать рассылку' }
  }
  const { error: recipientError } = await admin.from('campaign_recipients').insert(
    recipients.map((row) => ({ ...row, campaign_id: campaign.id }))
  )
  if (recipientError) {
    await admin.from('campaigns').delete().eq('id', campaign.id)
    return { success: false, error: recipientError.message }
  }
  revalidatePath('/dashboard/campaigns')
  return { success: true, count: recipients.length }
}

// ─── Стоп-список рассылок ─────────────────────────────────────────────────
// Номера здесь исключаются из аудитории всегда, независимо от того, купили
// они или нет (см. excludedPhones в eligibleRecipients).

export interface OptOutRow {
  phone: string
  reason: string | null
  block_bot_replies: boolean
  created_at: string
}

export async function getOptOutPhones(): Promise<OptOutRow[]> {
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return []
  const admin = createAdminClient()
  const { data } = await admin
    .from('campaign_opt_outs')
    .select('phone, reason, block_bot_replies, created_at')
    .order('created_at', { ascending: false })
  return (data ?? []) as OptOutRow[]
}

export async function addOptOutPhone(
  rawPhone: string,
  reason: string,
  blockBotReplies: boolean
): Promise<{ success: true } | { success: false; error: string }> {
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return { success: false, error: 'Нет доступа' }
  const phone = rawPhone.replace(/\D/g, '')
  if (phone.length < 5 || phone.length > 20) return { success: false, error: 'Некорректный номер телефона' }
  const admin = createAdminClient()
  const { error } = await admin.from('campaign_opt_outs').upsert({
    phone,
    reason: reason.trim().slice(0, 300) || null,
    block_bot_replies: blockBotReplies,
    created_by: me.id,
  })
  if (error) return { success: false, error: error.message }
  revalidatePath('/dashboard/campaigns')
  return { success: true }
}

export async function removeOptOutPhone(phone: string): Promise<{ success: boolean; error?: string }> {
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return { success: false, error: 'Нет доступа' }
  const admin = createAdminClient()
  const { error } = await admin.from('campaign_opt_outs').delete().eq('phone', phone)
  if (error) return { success: false, error: error.message }
  revalidatePath('/dashboard/campaigns')
  return { success: true }
}

export async function cancelCampaign(id: string): Promise<{ success: boolean; error?: string }> {
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return { success: false, error: 'Нет доступа' }
  const admin = createAdminClient()
  // Отменять можно и уже начатую рассылку: раньше условие было жёстко
  // status='scheduled', и стоило планировщику взять её в работу, как кнопка
  // «Отменить» переставала действовать — остановить отправку на полутысяче
  // адресатов было нечем. Планировщик проверяет статус между сообщениями и
  // останавливается сам.
  const { data, error } = await admin
    .from('campaigns')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .in('status', ['scheduled', 'running'])
    .select('id')
  if (error) return { success: false, error: error.message }
  if (!data?.length) return { success: false, error: 'Рассылка уже завершена — отменять нечего' }

  // Тем, до кого ещё не дошли, ставим «пропущен»: иначе они остались бы
  // висеть в «в очереди» навсегда.
  await admin
    .from('campaign_recipients')
    .update({ status: 'skipped', error: 'Рассылка отменена' })
    .eq('campaign_id', id)
    .eq('status', 'pending')

  revalidatePath('/dashboard/campaigns')
  return { success: true }
}

// ─── Живой ход рассылки ──────────────────────────────────────────────────────

export interface CampaignRecipientRow {
  id: number
  /** Номер или chat_id, куда уходит сообщение. */
  chat_id: string
  channel: string
  status: string
  error: string | null
  sent_at: string | null
  /** Имя клиента из сделки — по номеру его не узнать. */
  name: string | null
}

/**
 * Кому уже ушло, а кому нет. Страница опрашивает это, пока рассылка идёт,
 * поэтому запрос лёгкий: только получатели одной рассылки плюс имена из
 * сделок, на которые они ссылаются.
 */
export async function getCampaignRecipients(campaignId: string): Promise<CampaignRecipientRow[]> {
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return []

  const admin = createAdminClient()
  const { data } = await admin
    .from('campaign_recipients')
    .select('id, deal_id, chat_id, channel, status, error, sent_at')
    .eq('campaign_id', campaignId)
    .order('id')

  const rows = (data ?? []) as {
    id: number; deal_id: string; chat_id: string; channel: string
    status: string; error: string | null; sent_at: string | null
  }[]
  if (!rows.length) return []

  const { data: deals } = await admin
    .from('deals')
    .select('id, customer_name')
    .in('id', [...new Set(rows.map((row) => row.deal_id))])
  const nameByDeal = new Map(
    ((deals ?? []) as { id: string; customer_name: string | null }[])
      .map((deal) => [deal.id, deal.customer_name])
  )

  return rows.map((row) => ({
    id: row.id,
    chat_id: row.chat_id,
    channel: row.channel,
    status: row.status,
    error: row.error,
    sent_at: row.sent_at,
    name: nameByDeal.get(row.deal_id) ?? null,
  }))
}

// ─── Автоматические рассылки ─────────────────────────────────────────────────

export interface RecurringCampaignRow {
  id: string
  title: string
  message: string | null
  voice_id: string | null
  audience: CampaignAudience
  /** 1 — каждый день, 2 — через день. */
  interval_days: number
  /** Время по Бишкеку, 'HH:MM'. */
  send_at_time: string
  /** За сколько последних дней брать клиентов. null — без фильтра. */
  window_days: number | null
  is_active: boolean
  last_run_at: string | null
  created_at: string
  /** Имя того, кто завёл правило. */
  author: string | null
}

const RecurringSchema = z.object({
  title: z.string().trim().min(1).max(160),
  message: z.string().trim().max(4000),
  voiceId: z.string().trim().optional(),
  audience: z.enum(['not_purchased', 'purchased', 'all']),
  intervalDays: z.number().int().min(1).max(30),
  sendAtTime: z.string().regex(/^\d{2}:\d{2}$/, 'Время в формате ЧЧ:ММ'),
  windowDays: z.number().int().min(1).max(365).nullable(),
}).refine(
  (data) => data.message.length > 0 || Boolean(data.voiceId),
  { message: 'Нужен текст или голосовое' }
)

export async function getRecurringCampaigns(): Promise<RecurringCampaignRow[]> {
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return []

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('recurring_campaigns')
    .select('id, title, message, voice_id, audience, interval_days, send_at_time, window_days, is_active, last_run_at, created_at, created_by')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  // Таблицы может ещё не быть (миграция 045) — страница должна открываться.
  if (error || !data) return []

  const rows = data as (Omit<RecurringCampaignRow, 'author'> & { created_by: string | null })[]
  const authorIds = [...new Set(rows.flatMap((row) => row.created_by ? [row.created_by] : []))]
  const names = await employeeNames(authorIds)

  return rows.map((row) => ({ ...row, author: row.created_by ? names.get(row.created_by) ?? null : null }))
}

/** id сотрудника → имя. Пустой список сотрудников не запрашиваем. */
async function employeeNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const admin = createAdminClient()
  const { data } = await admin.from('employees').select('id, name').in('id', ids)
  return new Map(((data ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]))
}

export async function saveRecurringCampaign(
  input: unknown
): Promise<{ success: true } | { success: false; error: string }> {
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return { success: false, error: 'Нет доступа' }

  const parsed = RecurringSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Заполните форму' }
  }
  const voice = voiceById(parsed.data.voiceId)
  if (parsed.data.voiceId && !voice) return { success: false, error: 'Такого голосового нет' }

  const admin = createAdminClient()
  const { error } = await admin.from('recurring_campaigns').insert({
    title: parsed.data.title,
    message: parsed.data.message || null,
    voice_id: voice?.id ?? null,
    audience: parsed.data.audience,
    interval_days: parsed.data.intervalDays,
    send_at_time: parsed.data.sendAtTime,
    window_days: parsed.data.windowDays,
    created_by: me.id,
  })
  if (error) {
    if (error.message.includes('recurring_campaigns')) {
      return {
        success: false,
        error: 'Автоматические рассылки ещё не включены в базе: примените миграцию 045_recurring_campaigns.sql',
      }
    }
    return { success: false, error: error.message }
  }

  revalidatePath('/dashboard/campaigns')
  return { success: true }
}

/** Включить или выключить правило. Выключенное не запускается, но остаётся. */
export async function setRecurringActive(
  id: string,
  isActive: boolean
): Promise<{ success: true } | { success: false; error: string }> {
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return { success: false, error: 'Нет доступа' }

  const admin = createAdminClient()
  const { error } = await admin.from('recurring_campaigns').update({ is_active: isActive }).eq('id', id)
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/campaigns')
  return { success: true }
}

export async function deleteRecurringCampaign(
  id: string
): Promise<{ success: true } | { success: false; error: string }> {
  const me = await viewer()
  if (me?.role !== 'owner') return { success: false, error: 'Удалять может только владелец' }

  const admin = createAdminClient()
  const { error } = await admin
    .from('recurring_campaigns')
    .update({ deleted_at: new Date().toISOString(), is_active: false })
    .eq('id', id)
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/campaigns')
  return { success: true }
}


// ─── Прошлая рассылка ────────────────────────────────────────────────────────

/**
 * С какого момента считать «новых» клиентов для следующей рассылки.
 *
 * Берём ВРЕМЯ СОЗДАНИЯ последней неотменённой рассылки, а не время её
 * отправки. Получатели рассылки фиксируются в момент создания: кто написал
 * после этого, в неё уже не попал. Если бы граница шла от времени отправки,
 * клиент, написавший между созданием и отправкой прошлой рассылки, не
 * получил бы ни ту, ни следующую.
 *
 * Отменённые не в счёт: их никто не получил.
 */
export async function getLastCampaignMoment(): Promise<
  { at: string; title: string; scheduledAt: string } | null
> {
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return null

  const admin = createAdminClient()
  const { data } = await admin
    .from('campaigns')
    .select('title, created_at, scheduled_at')
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const row = data as { title: string; created_at: string; scheduled_at: string } | null
  return row ? { at: row.created_at, title: row.title, scheduledAt: row.scheduled_at } : null
}
