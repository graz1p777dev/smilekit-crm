'use server'

// Воронка продаж. Сделки живут в Supabase (036_deals.sql), переписка — во
// внешних системах: диалоги витрины Smilekit (Express + SQLite) и
// whatsapp_messages от Wazzup. Здесь только чтение переписки, вести её
// продолжают там же, где начали.

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { shopFetch, isShopConfigured } from '@/lib/shop-api'
import { upsertDealFromInbound } from '@/lib/deals/auto-create'
import { syncAmoChatHistory } from '@/lib/amocrm/history'
import { getAmoChatControlStatus, setAmoChatBotEnabled } from '@/lib/amocrm/bot-reply'
import { sendAmoChatMessage } from '@/lib/amocrm/chat'
import { sendGreenApiMessage, toGreenApiChatId } from '@/lib/greenapi/client'
import { recordAudit } from '@/actions/audit'
import { isAllowedBotControlRole } from '@/lib/bot-control-roles'
import type {
  Deal,
  DealEmployee,
  DealMessage,
  DealSource,
  DealStage,
  DealViewer,
} from '@/types'

export type DealActionResult<T = undefined> =
  | { success: true; data?: T }
  | { success: false; error: string }

// ─── Текущий сотрудник ───────────────────────────────────────────────────────

async function getViewer(): Promise<DealViewer | null> {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null

  const { data } = await supabase
    .from('employees')
    .select('id, role, name')
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .maybeSingle()

  return (data as DealViewer | null) ?? null
}

// ─── Данные для доски ────────────────────────────────────────────────────────

export interface DealsData {
  stages: DealStage[]
  deals: Deal[]
  employees: DealEmployee[]
  me: DealViewer | null
}

/**
 * Supabase (PostgREST) молча обрезает любую выборку до 1000 строк — сервер
 * игнорирует .limit() больше этого потолка (project max-rows), та же ловушка,
 * что уже дважды находили в рассылках (src/actions/campaigns.ts). При 1109+
 * сделках, отсортированных по created_at DESC, это отрезало 109 САМЫХ
 * СТАРЫХ — то есть весь исходный импорт из amoCRM пропадал с доски целиком
 * и не находился по прямой ссылке (?deal=...), хотя переход по ссылке
 * технически срабатывал.
 */
async function fetchAllDeals(supabase: Awaited<ReturnType<typeof createClient>>): Promise<Deal[]> {
  const PAGE_SIZE = 1000
  const rows: Deal[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('deals')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    rows.push(...((data ?? []) as Deal[]))
    if (!data || data.length < PAGE_SIZE) break
  }
  return rows
}

export async function getDealsData(): Promise<DealsData> {
  const me = await getViewer()
  if (!me) return { stages: [], deals: [], employees: [], me: null }

  const supabase = await createClient()
  const admin = createAdminClient()

  // deal_stages/deals — через RLS-клиент: какие сделки видны, решает БД.
  // employees — через admin: имена нужны для пикера ответственного.
  const [{ data: stages }, deals, { data: emps }] = await Promise.all([
    supabase
      .from('deal_stages')
      .select('id, name, sort_order, kind, color, is_default, description')
      .order('sort_order'),
    fetchAllDeals(supabase),
    admin
      .from('employees')
      .select('id, name, avatar_url')
      .is('deleted_at', null)
      .order('name'),
  ])

  return {
    stages: (stages ?? []) as DealStage[],
    deals,
    employees: (emps ?? []) as DealEmployee[],
    me,
  }
}

// ─── Форма сделки ────────────────────────────────────────────────────────────

const DealSchema = z.object({
  title: z.string().trim().min(1, 'Введите название сделки').max(300, 'Слишком длинное название'),
  stage_id: z.string().uuid('Выберите этап'),
  amount: z.number().nonnegative('Сумма не может быть отрицательной').nullable().optional(),
  currency: z.enum(['KGS', 'USD', 'RUB']).default('KGS'),
  customer_name: z.string().nullable().optional(),
  customer_phone: z.string().nullable().optional(),
  customer_username: z.string().nullable().optional(),
  city: z.string().max(120, 'Слишком длинное название города').nullable().optional(),
  address: z.string().max(500, 'Слишком длинный адрес').nullable().optional(),
  responsible_employee_id: z.string().uuid().nullable().optional(),
  note: z.string().nullable().optional(),
})

export type DealFormData = z.input<typeof DealSchema>

const clean = (value: string | null | undefined) => value?.trim() || null

export async function createDeal(input: DealFormData): Promise<DealActionResult<{ id: string }>> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  const parsed = DealSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }
  const d = parsed.data
  const supabase = await createClient()

  const { data: created, error } = await supabase
    .from('deals')
    .insert({
      title: d.title,
      stage_id: d.stage_id,
      amount: d.amount ?? null,
      currency: d.currency,
      customer_name: clean(d.customer_name),
      customer_phone: clean(d.customer_phone),
      customer_username: clean(d.customer_username),
      city: clean(d.city),
      address: clean(d.address),
      source: 'manual' satisfies DealSource,
      responsible_employee_id: d.responsible_employee_id ?? null,
      note: clean(d.note),
    })
    .select('id')
    .single()

  if (error || !created) {
    return { success: false, error: error?.message ?? 'Не удалось создать сделку' }
  }

  revalidatePath('/dashboard/deals')
  return { success: true, data: { id: (created as { id: string }).id } }
}

export async function updateDeal(id: string, input: DealFormData): Promise<DealActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  const parsed = DealSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }
  const d = parsed.data
  const supabase = await createClient()

  // status и stage_changed_at проставляет триггер БД — здесь их не трогаем.
  const { data: updated, error } = await supabase
    .from('deals')
    .update({
      title: d.title,
      stage_id: d.stage_id,
      amount: d.amount ?? null,
      currency: d.currency,
      customer_name: clean(d.customer_name),
      customer_phone: clean(d.customer_phone),
      customer_username: clean(d.customer_username),
      city: clean(d.city),
      address: clean(d.address),
      responsible_employee_id: d.responsible_employee_id ?? null,
      note: clean(d.note),
    })
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')

  if (error) return { success: false, error: error.message }
  if (!updated || updated.length === 0) return { success: false, error: 'Сделка недоступна' }

  revalidatePath('/dashboard/deals')
  return { success: true }
}

/** Перенос карточки между колонками. deal_events пишет триггер БД. */
export async function moveDeal(dealId: string, stageId: string): Promise<DealActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('deals')
    .update({ stage_id: stageId })
    .eq('id', dealId)
    .is('deleted_at', null)
    .select('id')

  if (error) return { success: false, error: error.message }
  if (!data || data.length === 0) return { success: false, error: 'Недостаточно прав' }

  revalidatePath('/dashboard/deals')
  return { success: true }
}

/** Мягкое удаление — история переходов в deal_events остаётся. */
export async function deleteDeal(id: string): Promise<DealActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('deals')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')

  if (error) return { success: false, error: error.message }
  if (!data || data.length === 0) return { success: false, error: 'Сделка недоступна' }

  revalidatePath('/dashboard/deals')
  return { success: true }
}

// ─── Сверка с витриной ───────────────────────────────────────────────────────

/** Диалог витрины в ответе GET /api/admin/crm/conversations. */
interface ShopConversation {
  id: number
  externalKey: string | null
  source: string
  customerName: string | null
  customerUsername: string | null
  customerPhone: string | null
}

interface ShopMessage {
  id: number
  direction: string
  text: string
  createdAt: string
}

// В воронке нет канала «amocrm»: через amoCRM у этого магазина приходят
// WhatsApp и Instagram, неопознанный origin считаем WhatsApp.
function shopSource(source: string): DealSource {
  if (source === 'telegram') return 'telegram'
  if (source === 'instagram') return 'instagram'
  return 'whatsapp'
}

/**
 * Страховка на случай, если push от витрины не дошёл (CRM перезапускалась,
 * сеть моргнула): проходим по всем диалогам витрины и заводим недостающие
 * сделки. Идемпотентно — существующие не трогаем.
 */
export async function reconcileDealsFromShop(): Promise<
  DealActionResult<{ created: number; checked: number }>
> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }
  // У SmileKit витрины нет — сделки живут в amoCRM: сверяемся с ним.
  if (process.env.AMOCRM_DOMAIN && process.env.AMOCRM_ACCESS_TOKEN) {
    return reconcileDealsFromAmo()
  }
  if (!isShopConfigured()) {
    return { success: false, error: 'Интеграция с витриной не настроена' }
  }

  const result = await shopFetch<{ conversations: ShopConversation[] }>('/crm/conversations')
  if (!result.ok) return { success: false, error: result.error }

  const conversations = result.data.conversations ?? []
  let created = 0
  for (const conversation of conversations) {
    if (!conversation.externalKey) continue
    const upsert = await upsertDealFromInbound({
      externalKey: conversation.externalKey,
      source: shopSource(conversation.source),
      customerName: conversation.customerName,
      customerPhone: conversation.customerPhone,
      customerUsername: conversation.customerUsername,
    })
    if (upsert.created) created += 1
  }

  revalidatePath('/dashboard/deals')
  return { success: true, data: { created, checked: conversations.length } }
}

/**
 * Сверка с amoCRM: все лиды + неразобранные заявки → сделки у нас.
 * Идемпотентно по external_key `amocrm:<lead_id>` — дублей не создаёт,
 * существующие сделки не трогает. То же, что делает вебхук, но разом
 * по всей базе амо (страховка от пропущенных вебхуков).
 */
async function reconcileDealsFromAmo(): Promise<DealActionResult<{ created: number; checked: number }>> {
  const domain = process.env.AMOCRM_DOMAIN
  const token = process.env.AMOCRM_ACCESS_TOKEN
  const headers = { authorization: `Bearer ${token}` }

  const fetchAll = async (path: string, embeddedKey: string) => {
    const items: Record<string, unknown>[] = []
    for (let page = 1; page <= 40; page++) {
      const res = await fetch(`https://${domain}${path}?limit=250&page=${page}`, { headers })
      if (res.status === 204) break
      if (!res.ok) throw new Error(`amoCRM ${path}: HTTP ${res.status}`)
      const data = await res.json()
      const batch = data?._embedded?.[embeddedKey] ?? []
      if (!batch.length) break
      items.push(...batch)
      if (!data._links?.next) break
    }
    return items
  }

  try {
    const [unsorted, leads] = await Promise.all([
      fetchAll('/api/v4/leads/unsorted', 'unsorted'),
      fetchAll('/api/v4/leads', 'leads'),
    ])

    const rows = new Map<string, { title: string; phone: string | null }>()
    for (const item of unsorted) {
      const embedded = item['_embedded'] as { leads?: { id?: number }[] } | undefined
      const leadId = embedded?.leads?.[0]?.id
      if (!leadId) continue
      const metadata = item['metadata'] as { from?: string; client?: { name?: string } } | undefined
      const phone = metadata?.from ?? null
      rows.set(String(leadId), {
        title: metadata?.client?.name || phone || `Заявка amoCRM ${leadId}`,
        phone,
      })
    }
    for (const lead of leads) {
      const id = String(lead['id'])
      if (rows.has(id)) continue
      rows.set(id, { title: (lead['name'] as string) || `Сделка amoCRM ${id}`, phone: null })
    }

    let created = 0
    for (const [leadId, row] of rows) {
      const upsert = await upsertDealFromInbound({
        externalKey: `amocrm:${leadId}`,
        source: 'amocrm',
        customerName: row.title,
        customerPhone: row.phone,
      })
      if (upsert.created) created += 1
    }

    revalidatePath('/dashboard/deals')
    return { success: true, data: { created, checked: rows.size } }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Сбой сверки с amoCRM' }
  }
}

// ─── Переписка по сделке ─────────────────────────────────────────────────────

export interface DealConversation {
  messages: DealMessage[]
  /** Почему переписки нет — показываем вместо пустоты. */
  note: string | null
}

// Ссылка на вложение (чек, фото) хранится маркером в конце text — отдельной
// колонки под медиа в amocrm_messages нет (см. src/lib/greenapi/bot-reply.ts).
const MEDIA_MARKER = /\n\[media\](\S+)$/

function toDealMessages(rows: {
  id: number
  direction: 'in' | 'out'
  sender: 'client' | 'bot' | 'operator'
  text: string
  created_at: string
}[] | null): DealMessage[] {
  return (rows ?? []).map((row) => {
    const media = row.text.match(MEDIA_MARKER)
    return {
      id: String(row.id),
      direction: row.direction,
      sender: row.sender,
      text: media ? row.text.slice(0, media.index) : row.text,
      created_at: row.created_at,
      media_url: media?.[1] ?? null,
    }
  })
}

/**
 * Читаемая расшифровка диалога: для сделок с витрины — её диалог,
 * для сделок Wazzup — whatsapp_messages. Только чтение.
 */
// Живой прод под сильной нагрузкой (шквал вебхуков amoCRM без общего лимита
// параллелизма) может замедлить даже простое чтение уже сохранённых
// сообщений — обычные прямые запросы к базе при этом остаются быстрыми,
// то есть тормозит именно нагрузка на сервер CRM, а не сам Supabase/amoCRM.
// Раньше таймаут стоял только вокруг синхронизации amojo — открытие
// сделки с уже сохранённой историей никак не было защищено и могло
// зависать на неопределённое время, упираясь в жёсткий клиентский
// тайм-аут (12с, DealModal.tsx) без осмысленного сообщения. Жёсткий
// потолок на всю функцию гарантирует быстрый и понятный ответ всегда.
/**
 * Менеджер пишет клиенту прямо из карточки сделки — работает для WhatsApp
 * (amoCRM-канал и Green API) одинаково. Записываем как sender='operator' ДО
 * отправки: это тот же сигнал «менеджер ведёт чат», что и обычное сообщение
 * из мессенджера (см. isManagerControllingChat) — бот сразу перестаёт отвечать
 * в этом чате, второй раз включать тумблер вручную не нужно.
 */
export async function sendDealMessage(dealId: string, text: string): Promise<DealActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }
  const trimmed = text.trim()
  if (!trimmed) return { success: false, error: 'Пустое сообщение' }

  const admin = createAdminClient()
  const { data: deal } = await admin
    .from('deals')
    .select('external_key')
    .eq('id', dealId)
    .maybeSingle()
  const externalKey = (deal as { external_key: string | null } | null)?.external_key
  if (!externalKey) return { success: false, error: 'У сделки нет привязанного чата' }

  const messageId = `manager:${dealId}:${Date.now()}`

  if (externalKey.startsWith('greenapi:')) {
    const phone = externalKey.slice('greenapi:'.length)
    await admin.from('amocrm_messages').insert({
      amo_message_id: `ga:${messageId}`,
      chat_id: phone,
      direction: 'out',
      sender: 'operator',
      author_name: me.name,
      text: trimmed,
    })
    try {
      await sendGreenApiMessage(toGreenApiChatId(phone), trimmed)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Не удалось отправить' }
    }
    revalidatePath('/dashboard/deals')
    return { success: true }
  }

  if (externalKey.startsWith('amocrm:')) {
    const leadId = externalKey.slice('amocrm:'.length)
    const { data: chatRow } = await admin
      .from('amocrm_messages')
      .select('chat_id, contact_id')
      .eq('lead_id', leadId)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
    const chat = chatRow as { chat_id: string; contact_id: string | null } | null
    if (!chat) return { success: false, error: 'Чат ещё не начался — нет истории amoCRM' }
    await admin.from('amocrm_messages').insert({
      amo_message_id: messageId,
      chat_id: chat.chat_id,
      lead_id: leadId,
      contact_id: chat.contact_id,
      direction: 'out',
      sender: 'operator',
      author_name: me.name,
      text: trimmed,
    })
    try {
      await sendAmoChatMessage({ chatId: chat.chat_id, leadId, contactId: chat.contact_id, text: trimmed })
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Не удалось отправить' }
    }
    revalidatePath('/dashboard/deals')
    return { success: true }
  }

  return { success: false, error: 'Канал сделки не поддерживает отправку из CRM' }
}

export async function getDealConversation(dealId: string): Promise<DealConversation> {
  const timedOut = Symbol('timeout')
  const result = await Promise.race([
    loadDealConversation(dealId),
    new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), 9_000)),
  ])
  if (result !== timedOut) return result
  return {
    messages: [],
    note: 'Сервер сейчас перегружен — попробуйте открыть сделку ещё раз через несколько секунд.',
  }
}

async function loadDealConversation(dealId: string): Promise<DealConversation> {
  const me = await getViewer()
  if (!me) return { messages: [], note: 'Нет авторизации' }

  const supabase = await createClient()
  const { data } = await supabase
    .from('deals')
    .select('external_key, customer_phone')
    .eq('id', dealId)
    .maybeSingle()
  const deal = data as { external_key: string | null; customer_phone: string | null } | null
  if (!deal) return { messages: [], note: 'Сделка недоступна' }

  if (deal.external_key?.startsWith('greenapi:')) {
    // WhatsApp через Green API: chat_id — номер телефона, история в той же
    // amocrm_messages (см. src/lib/greenapi/bot-reply.ts).
    const phone = deal.external_key.slice('greenapi:'.length)
    const admin = createAdminClient()
    const { data: rows } = await admin
      .from('amocrm_messages')
      .select('id, direction, sender, text, created_at')
      .eq('chat_id', phone)
      .order('created_at')
      .order('id')
      .limit(200)
    const messages = toDealMessages(rows)
    return { messages, note: messages.length ? null : 'Сообщений пока нет' }
  }

  if (deal.external_key?.startsWith('wazzup:')) {
    const phone = deal.external_key.slice('wazzup:'.length)
    const { data: rows } = await supabase
      .from('whatsapp_messages')
      .select('id, direction, text, created_at')
      .eq('phone', phone)
      .order('created_at')
      .limit(200)
    const messages = (rows ?? []) as DealMessage[]
    return { messages, note: messages.length ? null : 'Сообщений пока нет' }
  }

  if (deal.external_key?.startsWith('amocrm:')) {
    // Переписка WhatsApp-канала amoCRM живёт у нас (amocrm_messages,
    // миграция 041) — сервер мастер истории, см. src/lib/amocrm/bot-reply.ts.
    const leadId = deal.external_key.slice('amocrm:'.length)
    // Системная история amoCRM не принадлежит конкретному сотруднику.
    // Авторизация уже проверена выше, поэтому читаем её admin-клиентом:
    // пользовательский RLS-клиент возвращал пусто и запускал медленную
    // синхронизацию amojo при каждом открытии сделки.
    const admin = createAdminClient()
    const readStoredMessages = () => admin
      .from('amocrm_messages')
      .select('id, direction, sender, text, created_at')
      .eq('lead_id', leadId)
      .order('created_at')
      .order('id')
      .limit(200)
    let { data: rows } = await readStoredMessages()
    // Вебхук уже поддерживает живую историю. amojo нужен только для старого
    // диалога, которого ещё нет локально — не задерживаем им обычное открытие.
    // amojo иногда подвисает дольше клиентского таймаута карточки (12с):
    // getChatSession может уйти в 3 ретрая по 8с = до ~27с. Ограничиваем
    // ожидание синхронизации отдельным потолком и не блокируем открытие
    // сделки дольше него — sync доводим до конца в фоне, следующее открытие
    // застанет уже сохранённые сообщения.
    if (!rows?.length) {
      const { data: chatRow } = await admin
        .from('amocrm_messages')
        .select('chat_id')
        .eq('lead_id', leadId)
        .limit(1)
        .maybeSingle()
      if (chatRow?.chat_id) {
        const chatId = String(chatRow.chat_id)
        const sync = syncAmoChatHistory(chatId, leadId).catch((error) => {
          console.error('deal conversation: amo history sync failed', error)
        })
        const timedOut = Symbol('timeout')
        const raced = await Promise.race([
          sync.then(() => 'done' as const),
          new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), 6_000)),
        ])
        if (raced === 'done') {
          const refreshed = await readStoredMessages()
          rows = refreshed.data
        } else {
          return {
            messages: [],
            note: 'amoCRM отвечает медленнее обычного — история подгружается в фоне, откройте сделку ещё раз через несколько секунд.',
          }
        }
      }
    }
    const messages = toDealMessages(rows)
    return { messages, note: messages.length ? null : 'Сообщений пока нет' }
  }

  if (!deal.external_key) {
    return { messages: [], note: 'Сделка заведена вручную — переписки нет' }
  }
  if (!isShopConfigured()) {
    return { messages: [], note: 'Интеграция с витриной не настроена' }
  }

  // У витрины диалог адресуется числовым id, а в сделке лежит external_key —
  // сначала находим id в списке диалогов.
  const list = await shopFetch<{ conversations: ShopConversation[] }>('/crm/conversations')
  if (!list.ok) return { messages: [], note: list.error }

  const found = (list.data.conversations ?? []).find(c => c.externalKey === deal.external_key)
  if (!found) return { messages: [], note: 'Диалог на витрине не найден' }

  const detail = await shopFetch<{ messages: ShopMessage[] }>(
    `/crm/conversations/${found.id}`
  )
  if (!detail.ok) return { messages: [], note: detail.error }

  const messages: DealMessage[] = (detail.data.messages ?? []).map(m => ({
    id: String(m.id),
    direction: m.direction === 'incoming' ? 'in' : 'out',
    text: m.text,
    created_at: m.createdAt,
  }))
  return { messages, note: messages.length ? null : 'Сообщений пока нет' }
}

// ─── Управление ботом по конкретному чату amoCRM ─────────────────────────────
// Как только в чат вступил живой менеджер, бот больше не отвечает в нём —
// это правило по умолчанию. Тумблер в карточке сделки — явный override:
// «вернуть чат боту» действует до следующего сообщения менеджера в этом же
// чате (тогда управление снова у человека), см. isManagerControllingChat
// в src/lib/amocrm/bot-reply.ts.

export interface DealBotControl {
  /** null — у сделки ещё нет ни одного сообщения amoCRM, тумблер показывать нечего. */
  chatId: string | null
  managerControls: boolean
}

export async function getDealBotControl(dealId: string): Promise<DealBotControl> {
  const me = await getViewer()
  if (!me) return { chatId: null, managerControls: false }

  const supabase = await createClient()
  const { data } = await supabase.from('deals').select('external_key').eq('id', dealId).maybeSingle()
  const externalKey = (data as { external_key: string | null } | null)?.external_key
  if (!externalKey?.startsWith('amocrm:')) return { chatId: null, managerControls: false }

  return getAmoChatControlStatus(externalKey.slice('amocrm:'.length))
}

export async function setDealBotControl(chatId: string, botEnabled: boolean): Promise<DealActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }
  if (!isAllowedBotControlRole(me.role)) return { success: false, error: 'Недостаточно прав' }
  try {
    const admin = createAdminClient()
    const { data: before } = await admin
      .from('amocrm_chat_control')
      .select('bot_enabled')
      .eq('chat_id', chatId)
      .maybeSingle()

    await setAmoChatBotEnabled(chatId, botEnabled, me.id)

    const beforeEnabled = (before as { bot_enabled?: boolean } | null)?.bot_enabled
    await recordAudit({
      action: 'update',
      resourceType: 'amocrm_chat_control',
      resourceId: chatId,
      summary: `Управление ботом в чате ${chatId}: ${beforeEnabled ?? '—'} → ${botEnabled}`,
    })

    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Не удалось переключить управление' }
  }
}
