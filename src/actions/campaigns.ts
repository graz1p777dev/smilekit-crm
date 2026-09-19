'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { voiceById } from '@/config/voice-messages'
import { BULK_BROADCAST_AUTHOR_MARKER } from '@/lib/greenapi/bot-reply'
import { isManagerActiveInChat, MANAGER_ACTIVE_WINDOW_MS } from '@/lib/campaigns/manager-activity'

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
  /**
   * Слать и в чаты, где менеджер общается прямо сейчас (писал за последние
   * MANAGER_ACTIVE_WINDOW_MS из src/lib/campaigns/manager-activity.ts). По умолчанию такие чаты пропускаются, чтобы
   * рассылка не влезла в живой разговор.
   */
  includeManagerChats?: boolean
  /**
   * Не слать тем, кто уже получил рассылку начиная с этого момента (ISO).
   * Защита от повторной отправки: 17.09 вторую рассылку с тем же текстом
   * поставили на тех же 187 человек через 50 минут после первой.
   */
  skipReachedSince?: string
}

/** Сколько клиентов попало в период, но отсеялось по правилам — для панели. */
export interface AudienceExclusions {
  managerChats: number
  alreadyReached: number
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
  return (await selectRecipients(filter, true)).recipients
}

/** withList = false — только числа (предпросмотр): список получателей не собирается. */
async function selectRecipients(
  filter: AudienceFilter | undefined,
  withList: boolean
): Promise<{ recipients: Recipient[]; count: number; excluded: AudienceExclusions }> {
  const excluded: AudienceExclusions = { managerChats: 0, alreadyReached: 0 }
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
    return { recipients: [], count: 0, excluded }
  }

  // Сами правила подбора (покупка, стоп-список, период, «уже получили») —
  // в функции базы campaign_audience (миграция 064). Раньше здесь в Node
  // вычитывались все сделки (12+ тыс. строк постранично по 1000), весь
  // chat_control и все сообщения клиентов за период — на каждое изменение
  // фильтра в предпросмотре. Здесь остаётся только «менеджер в переписке»:
  // это правило живёт в isManagerActiveInChat и нужно ему немного строк.
  const cutoff = new Date(Date.now() - MANAGER_ACTIVE_WINDOW_MS).toISOString()
  const [operatorRows, chatControls] = await Promise.all([
    // ТОЛЬКО сообщения менеджеров. Раньше здесь вычитывалась вся таблица
    // переписки целиком (десятки тысяч строк, постранично по 1000) — ради
    // двух производных величин. Именно это подвешивало страницу рассылок:
    // в логах прода «The destination stream closed early».
    fetchAllRows<{ chat_id: string; created_at: string; author_name: string | null }>(
      admin, 'chat_messages', 'chat_id, created_at, author_name',
      // Рассылку останавливает только работа менеджера за последние
      // MANAGER_ACTIVE_WINDOW_MS (см. isManagerActiveInChat) — более старые
      // сообщения на ответ не влияют. Раньше здесь читалась вся история
      // (~20 тыс. строк, 5–8 с на каждый пересчёт аудитории), и страница
      // рассылок стояла в очереди за этим запросом.
      (q) => q.eq('sender', 'operator')
        .gte('created_at', cutoff)
        .order('id', { ascending: false })
    ),
    // Отметки chat_control старше окна на ответ isManagerActiveInChat не
    // влияют: если после отметки менеджер писал, решает его сообщение, а если
    // не писал — последняя активность старше окна и чат не «у менеджера».
    // Поэтому читаем только свежие отметки, а не всю таблицу.
    fetchAllRows<{ chat_id: string; bot_enabled: boolean; updated_at: string }>(
      admin, 'chat_control', 'chat_id, bot_enabled, updated_at',
      (q) => q.gte('updated_at', cutoff).order('chat_id')
    ),
  ])

  // «Менеджер ведёт чат»: явная отметка перекрывает прошлые сообщения
  // менеджера, но только до его следующего сообщения.
  const controlByChat = new Map(chatControls.map((row) => [String(row.chat_id), row]))
  const lastOperatorAtByChat = new Map<string, string>()
  // Массовая рассылка, отправленная мимо CRM, помечается BULK_BROADCAST_AUTHOR_MARKER
  // и работой менеджера НЕ является. Бот (isManagerControllingChat) эти строки
  // всегда пропускал, а подбор получателей — нет: 17.09 пятеро клиентов не
  // получили рассылку, потому что считались «в разговоре с менеджером».
  for (const row of operatorRows) {
    if (row.author_name === BULK_BROADCAST_AUTHOR_MARKER) continue
    const chatId = String(row.chat_id)
    const known = lastOperatorAtByChat.get(chatId)
    if (!known || row.created_at > known) lastOperatorAtByChat.set(chatId, row.created_at)
  }
  // Рассылку пропускаем только в чатах, где менеджер общается ПРЯМО СЕЙЧАС.
  //
  // Раньше хватало одного сообщения менеджера когда угодно — и клиент выпадал
  // из рассылок навсегда. 17.09 так не получили рассылку 106 человек, с
  // которыми менеджер переписывался утром с телефона WhatsApp. Правило
  // владельца: если менеджер молчит в чате 30 минут, туда можно слать.
  //
  // Это правило ТОЛЬКО для рассылок. Отвечает ли в чате бот, решает другая
  // логика (src/lib/chat-control.ts) — её не трогаем.
  const now = Date.now()
  const managerChats = [...new Set([...lastOperatorAtByChat.keys(), ...controlByChat.keys()])].filter((chatId) =>
    isManagerActiveInChat(lastOperatorAtByChat.get(chatId) ?? null, controlByChat.get(chatId), now)
  )

  const { data, error } = await admin.rpc('campaign_audience', {
    p_audience: audience,
    p_from: fromDate ? fromDate.toISOString() : null,
    p_to: toDate ? toDate.toISOString() : null,
    p_skip_reached_since: filter?.skipReachedSince || null,
    p_manager_chat_ids: managerChats,
    p_include_manager_chats: Boolean(filter?.includeManagerChats),
    p_whatsapp_ready: greenApiReady,
    p_with_list: withList,
  })
  if (error) throw new Error(`campaign_audience: ${error.message}`)
  const result = data as {
    count: number
    already_reached: number
    manager_chats: number
    recipients: Recipient[] | null
  }
  excluded.alreadyReached = result.already_reached
  excluded.managerChats = result.manager_chats
  return { recipients: result.recipients ?? [], count: result.count, excluded }
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
export interface AudiencePreview {
  count: number
  excluded: AudienceExclusions
}

/** Живой пересчёт аудитории под выбранные фильтры (для UI, до создания рассылки). */
export async function getAudiencePreview(input: {
  dateFrom?: string
  dateTo?: string
  audience?: CampaignAudience
  includeManagerChats?: boolean
  skipReachedSince?: string
}): Promise<AudiencePreview> {
  const empty: AudiencePreview = { count: 0, excluded: { managerChats: 0, alreadyReached: 0 } }
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return empty
  const { count, excluded } = await selectRecipients({
    from: input.dateFrom || undefined,
    to: input.dateTo || undefined,
    audience: input.audience,
    includeManagerChats: input.includeManagerChats,
    skipReachedSince: input.skipReachedSince,
  }, false)
  return { count, excluded }
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
  includeManagerChats: z.boolean().optional(),
  skipReachedSince: z.string().optional(),
  /** Период «С прошлой рассылки»: до времени отправки, получатели — в момент отправки. */
  refreshAtSend: z.boolean().optional(),
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
  const refreshAtSend = Boolean(parsed.data.refreshAtSend)
  const filter: AudienceFilter = {
    from: parsed.data.dateFrom,
    // При пересчёте в момент отправки период идёт до времени отправки, а не
    // до того, что прислал браузер: иначе он разошёлся бы с полем «Дата и время».
    to: refreshAtSend ? scheduledAt.toISOString() : parsed.data.dateTo,
    audience: parsed.data.audience,
    includeManagerChats: parsed.data.includeManagerChats,
    skipReachedSince: parsed.data.skipReachedSince,
  }
  const recipients = await eligibleRecipients(filter)
  // С пересчётом при отправке пустой список сейчас — не ошибка: клиенты ещё
  // могут написать до времени отправки.
  if (!recipients.length && !refreshAtSend) return { success: false, error: 'Нет клиентов под выбранные фильтры' }

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
    ...(refreshAtSend ? { refresh_filter: filter } : {}),
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
  const { error: recipientError } = recipients.length
    ? await admin.from('campaign_recipients').insert(recipients.map((row) => ({ ...row, campaign_id: campaign.id })))
    : { error: null }
  if (recipientError) {
    await admin.from('campaigns').delete().eq('id', campaign.id)
    return { success: false, error: recipientError.message }
  }
  revalidatePath('/dashboard/campaigns')
  return { success: true, count: recipients.length }
}

// ─── Стоп-список рассылок ─────────────────────────────────────────────────
// Номера здесь исключаются из аудитории всегда, независимо от того, купили
// они или нет (см. campaign_opt_outs в функции campaign_audience, миграция 064).

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
  period_mode: 'days' | 'hours24' | 'since_last' | 'from_date'
  /** Для «с даты»: 'YYYY-MM-DD'. */
  from_date: string | null
  include_manager_chats: boolean
  skip_reached_today: boolean
  /** Сколько человек получили бы рассылку на момент подсчёта. */
  audience_estimate: number | null
  audience_estimated_at: string | null
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
  periodMode: z.enum(['days', 'hours24', 'since_last', 'from_date']).default('days'),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  includeManagerChats: z.boolean().default(false),
  skipReachedToday: z.boolean().default(true),
}).refine(
  (data) => data.message.length > 0 || Boolean(data.voiceId),
  { message: 'Нужен текст или голосовое' }
).refine(
  (data) => data.periodMode !== 'from_date' || Boolean(data.fromDate),
  { message: 'Выберите дату, с которой брать клиентов' }
)

export async function getRecurringCampaigns(): Promise<RecurringCampaignRow[]> {
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return []

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('recurring_campaigns')
    .select('id, title, message, voice_id, audience, interval_days, send_at_time, window_days, period_mode, from_date, ' +
      'include_manager_chats, skip_reached_today, audience_estimate, audience_estimated_at, is_active, last_run_at, created_at, created_by')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  // Таблицы может ещё не быть (миграция 045) — страница должна открываться.
  if (error || !data) return []

  const rows = data as unknown as (Omit<RecurringCampaignRow, 'author'> & { created_by: string | null })[]
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
  // id передан — правим существующее правило, иначе создаём новое.
  const ruleId = typeof (input as { id?: unknown })?.id === 'string' ? (input as { id: string }).id : null
  const fields = {
    title: parsed.data.title,
    message: parsed.data.message || null,
    voice_id: voice?.id ?? null,
    audience: parsed.data.audience,
    interval_days: parsed.data.intervalDays,
    send_at_time: parsed.data.sendAtTime,
    window_days: parsed.data.periodMode === 'days' ? parsed.data.windowDays : null,
    period_mode: parsed.data.periodMode,
    from_date: parsed.data.periodMode === 'from_date' ? parsed.data.fromDate : null,
    include_manager_chats: parsed.data.includeManagerChats,
    skip_reached_today: parsed.data.skipReachedToday,
  }
  const { data: created, error } = ruleId
    ? await admin.from('recurring_campaigns').update(fields).eq('id', ruleId).is('deleted_at', null).select('id').single()
    : await admin.from('recurring_campaigns').insert({ ...fields, created_by: me.id }).select('id').single()
  if (error) {
    if (error.message.includes('recurring_campaigns')) {
      return {
        success: false,
        error: 'Автоматические рассылки ещё не включены в базе: примените миграцию 045_recurring_campaigns.sql',
      }
    }
    return { success: false, error: error.message }
  }

  // Сразу считаем, сколько человек получит рассылка, — чтобы в карточке
  // правила число было с первой минуты, а не через сутки.
  const { estimateRecurringAudience } = await import('@/lib/campaigns/recurring')
  await estimateRecurringAudience((created as { id: string }).id).catch(() => null)

  revalidatePath('/dashboard/campaigns')
  return { success: true }
}

/** Кнопка «Обновить» в карточке правила: пересчитать аудиторию сейчас. */
export async function refreshRecurringEstimate(
  id: string
): Promise<{ success: true; count: number } | { success: false; error: string }> {
  const me = await viewer()
  if (!me || !['owner', 'rop'].includes(me.role)) return { success: false, error: 'Нет доступа' }
  const { estimateRecurringAudience } = await import('@/lib/campaigns/recurring')
  const count = await estimateRecurringAudience(id)
  if (count === null) return { success: false, error: 'Правило не найдено' }
  revalidatePath('/dashboard/campaigns')
  return { success: true, count }
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
