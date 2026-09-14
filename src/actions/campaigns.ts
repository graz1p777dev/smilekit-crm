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
  scheduled_at: string
  status: 'scheduled' | 'running' | 'completed' | 'cancelled' | 'failed'
  recipient_count: number
  sent_count: number
  failed_count: number
  created_at: string
}

export interface CampaignsData {
  campaigns: CampaignRow[]
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
 * amocrm_messages и почти 1000 сделками это тихо теряло данные —
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

async function eligibleRecipients(filter?: AudienceFilter): Promise<Recipient[]> {
  const admin = createAdminClient()
  const audience: CampaignAudience = filter?.audience ?? 'not_purchased'
  const dateFilter = filter
  // Green API шлёт по номеру телефона, amojo — только по внутреннему chat_id
  // amoCRM. Пока Green API настроен, номера без чата в amoCRM (клиенты, чью
  // переписку амо не успела синхронизировать) тоже становятся доступны.
  const greenApiReady = Boolean(process.env.GREENAPI_ID_INSTANCE && process.env.GREENAPI_API_TOKEN_INSTANCE)
  const [deals, { data: orders }, amoMessages, { data: optOuts }] = await Promise.all([
    fetchAllRows<{ id: string; source: string; external_key: string | null; customer_phone: string | null }>(
      admin, 'deals', 'id, source, external_key, customer_phone',
      (q) => (audience === 'all' ? q : q.neq('status', 'won')).is('deleted_at', null).order('id')
    ),
    admin
      .from('orders')
      .select('deal_id')
      .neq('status', 'cancelled')
      .is('deleted_at', null),
    fetchAllRows<{ id: number; chat_id: string; lead_id: string | null; contact_id: string | null; sender: string; created_at: string }>(
      admin, 'amocrm_messages', 'id, chat_id, lead_id, contact_id, sender, created_at',
      (q) => q.order('id', { ascending: false })
    ),
    admin.from('campaign_opt_outs').select('phone'),
  ])
  const chatControls = await fetchAllRows<{ chat_id: string; bot_enabled: boolean; updated_at: string }>(
    admin, 'amocrm_chat_control', 'chat_id, bot_enabled, updated_at', (q) => q.order('chat_id')
  )
  const purchased = new Set((orders ?? []).flatMap((row) => row.deal_id ? [String(row.deal_id)] : []))
  const excludedPhones = new Set((optOuts ?? []).map((row) => row.phone as string))
  // «Менеджер ведёт чат» — та же логика, что в isManagerControllingChat
  // (src/lib/amocrm/bot-reply.ts): запись в amocrm_chat_control перекрывает
  // прошлые сообщения менеджера, но только до его следующего сообщения.
  const controlByChat = new Map(chatControls.map((row) => [String(row.chat_id), row]))
  const lastOperatorAtByChat = new Map<string, string>()
  for (const row of amoMessages ?? []) {
    if (row.sender !== 'operator') continue
    const chatId = String(row.chat_id)
    const known = lastOperatorAtByChat.get(chatId)
    if (!known || row.created_at > known) lastOperatorAtByChat.set(chatId, row.created_at)
  }
  const managerChats = new Set(
    [...new Set((amoMessages ?? []).map((row) => String(row.chat_id)))].filter((chatId) => {
      const lastOperatorAt = lastOperatorAtByChat.get(chatId) ?? null
      const control = controlByChat.get(chatId)
      if (!control) return lastOperatorAt !== null
      const overrideIsFresh = lastOperatorAt === null
        || new Date(control.updated_at).getTime() > new Date(lastOperatorAt).getTime()
      return overrideIsFresh ? !control.bot_enabled : true
    })
  )
  const amoByLead = new Map<string, { chatId: string; contactId: string | null }>()
  // amoMessages отсортирован id DESC — первое сообщение клиента на lead_id
  // при таком порядке и есть последнее по времени.
  const lastClientMessageAtByLead = new Map<string, string>()
  for (const row of amoMessages ?? []) {
    if (!row.lead_id) continue
    if (row.sender === 'client' && !lastClientMessageAtByLead.has(String(row.lead_id))) {
      lastClientMessageAtByLead.set(String(row.lead_id), row.created_at)
    }
    if (amoByLead.has(String(row.lead_id))) continue
    amoByLead.set(String(row.lead_id), {
      chatId: String(row.chat_id),
      contactId: row.contact_id ? String(row.contact_id) : null,
    })
  }
  const fromTime = dateFilter?.from ? new Date(dateFilter.from).getTime() : null
  const toTime = dateFilter?.to ? new Date(dateFilter.to).getTime() : null

  return (deals ?? []).flatMap((deal): Recipient[] => {
    const id = String(deal.id)
    const key = String(deal.external_key || '')
    if (!key) return []
    if (audience === 'not_purchased' && purchased.has(id)) return []
    if (audience === 'purchased' && !purchased.has(id)) return []
    if (excludedPhones.has(normalizePhone(deal.customer_phone))) return []
    if (deal.source === 'telegram' && key.startsWith('telegram:')) {
      if (fromTime || toTime) return [] // фильтр по дате пока считаем только для WhatsApp-канала
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
    if (deal.source === 'amocrm' && key.startsWith('amocrm:')) {
      // Сделки amoCRM — это WhatsApp-канал (см. upsertDealFromInbound в
      // bot-reply.ts, source всегда 'amocrm', отдельного 'instagram' пока
      // нет). 'whatsapp' — реальный канал отправки, CHECK на channel того
      // же campaign_recipients требует конкретное значение, не 'amocrm'.
      const leadId = key.slice('amocrm:'.length)
      const chat = amoByLead.get(leadId)
      const phone = normalizePhone(deal.customer_phone)
      // Без чата в amoCRM отправить можно только через Green API (по номеру).
      if (!chat && !(greenApiReady && phone.length >= 9)) return []
      if (chat && managerChats.has(chat.chatId)) return []
      if (fromTime || toTime) {
        const lastAt = lastClientMessageAtByLead.get(leadId)
        if (!lastAt) return []
        const lastTime = new Date(lastAt).getTime()
        if (fromTime && lastTime < fromTime) return []
        if (toTime && lastTime > toTime) return []
      }
      return [{
        deal_id: id,
        channel: 'whatsapp',
        external_key: key,
        // Green API адресует по номеру, amojo — по chat_id. Планировщик
        // различает их по формату (см. scheduler.ts): только цифры — номер.
        chat_id: greenApiReady && phone.length >= 9 ? phone : chat!.chatId,
        lead_id: leadId,
        contact_id: chat?.contactId ?? null,
      }]
    }
    if (deal.source === 'whatsapp' && key.startsWith('greenapi:')) {
      // Сделки, заведённые уже напрямую через Green API (без amoCRM в
      // цепочке, см. resolveGreenApiExternalKey в src/lib/greenapi/bot-reply.ts).
      // Раньше этой ветки не было вовсе — такие сделки не попадали ни в одну
      // рассылку, независимо от выбранной аудитории.
      const phone = key.slice('greenapi:'.length)
      if (!greenApiReady || phone.length < 9) return []
      if (managerChats.has(phone)) return []
      if (fromTime || toTime) return [] // фильтр по дате пока считаем только для amoCRM-истории
      return [{
        deal_id: id,
        channel: 'whatsapp',
        external_key: key,
        chat_id: phone,
        lead_id: null,
        contact_id: null,
      }]
    }
    return []
  })
}

/**
 * Данные страницы рассылок. Здесь НЕТ подсчёта аудитории, и это принципиально.
 *
 * eligibleRecipients() вычитывает всю таблицу amocrm_messages (тысячи строк,
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
  if (!me || !['owner', 'rop'].includes(me.role)) return { campaigns: [], eligibleCount: null, optOuts: [] }
  const admin = createAdminClient()
  const [{ data }, optOuts] = await Promise.all([
    admin.from('campaigns').select('*').order('created_at', { ascending: false }).limit(50),
    getOptOutPhones(),
  ])
  return { campaigns: (data ?? []) as CampaignRow[], eligibleCount: null, optOuts }
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
  const { data, error } = await admin
    .from('campaigns')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('status', 'scheduled')
    .select('id')
  if (error || !data?.length) return { success: false, error: error?.message ?? 'Рассылку уже нельзя отменить' }
  revalidatePath('/dashboard/campaigns')
  return { success: true }
}
