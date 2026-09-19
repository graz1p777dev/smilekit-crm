'use server'

// Воронка продаж. Сделки живут в Supabase (036_deals.sql), переписка — во
// внешних системах: диалоги витрины Smilekit (Express + SQLite) и
// whatsapp_messages от Wazzup. Здесь только чтение переписки, вести её
// продолжают там же, где начали.

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getChatControlStatus, setChatBotEnabled } from '@/lib/chat-control'
import { sendGreenApiMessage, toGreenApiChatId } from '@/lib/greenapi/client'
import { recordAudit } from '@/actions/audit'
import { isAllowedChatControlRole } from '@/lib/bot-control-roles'
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
// Доске нужны не все поля строки: список колонок (прежний DEAL_BOARD_COLUMNS:
// id, title, stage_id, amount, currency, customer_*, city, address, source,
// external_key, responsible_employee_id, note, status, stage_changed_at,
// created_at, updated_at) теперь задан в функции базы deals_list_json.
//
// Раньше сделки читались постранично — 13 последовательных запросов, и
// каждый заново проверял RLS и сортировал всю таблицу (~0,3 с на страницу,
// ~4 с только в базе). deals_list_json (миграция 066) отдаёт ту же выборку
// (deleted_at IS NULL, created_at DESC, видимость по RLS вызывающего) одним
// JSON — на него лимит PostgREST в 1000 строк не действует.
async function fetchAllDeals(supabase: Awaited<ReturnType<typeof createClient>>): Promise<Deal[]> {
  const { data, error } = await supabase.rpc('deals_list_json', { p_compact: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as Deal[]
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


// В воронке нет канала «amocrm»: через amoCRM у этого магазина приходят
// WhatsApp и Instagram, неопознанный origin считаем WhatsApp.

/**
 * Страховка на случай, если push от витрины не дошёл (CRM перезапускалась,
 * сеть моргнула): проходим по всем диалогам витрины и заводим недостающие
 * сделки. Идемпотентно — существующие не трогаем.
 */
// Сверка с внешними системами убрана вместе с интеграцией amoCRM: канал
// один — Green API, и сделки заводит он сам на входящем сообщении
// (upsertDealFromInbound в src/lib/greenapi/bot-reply.ts). Тянуть лидов
// неоткуда, поэтому кнопки «Синхронизировать» на доске больше нет.

// ─── Переписка по сделке ─────────────────────────────────────────────────────

export interface DealConversation {
  messages: DealMessage[]
  /** Почему переписки нет — показываем вместо пустоты. */
  note: string | null
}

// Ссылка на вложение (чек, фото) хранится маркером в конце text — отдельной
// колонки под медиа в chat_messages нет (см. src/lib/greenapi/bot-reply.ts).
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
    .select('external_key, customer_phone')
    .eq('id', dealId)
    .maybeSingle()
  const row = deal as { external_key: string | null; customer_phone: string | null } | null

  // Канал отправки теперь один — Green API, а адресуется он номером.
  // Для сделок с ключом greenapi:<phone> номер лежит прямо в ключе; у старых
  // сделок, заведённых из amoCRM, берём телефон клиента. Отправка через amojo
  // убрана вместе с интеграцией, но история этих сделок осталась на месте.
  const phone = row?.external_key?.startsWith('greenapi:')
    ? row.external_key.slice('greenapi:'.length).replace(/\D/g, '')
    : (row?.customer_phone ?? '').replace(/\D/g, '')

  if (!phone) {
    return { success: false, error: 'У клиента нет номера — написать из CRM нечем' }
  }

  const messageId = `manager:${dealId}:${Date.now()}`

  // Пишем в историю ДО отправки: та же запись служит сигналом «менеджер ведёт
  // чат», и бот сразу перестаёт отвечать этому номеру.
  await admin.from('chat_messages').insert({
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
    // Не ушло — убираем запись: иначе в истории висело бы сообщение, которого
    // клиент не получал, а бот считал бы, что чат ведёт менеджер, и молчал.
    await admin.from('chat_messages').delete().eq('amo_message_id', `ga:${messageId}`)
    return { success: false, error: error instanceof Error ? error.message : 'Не удалось отправить' }
  }
  revalidatePath('/dashboard/deals')
  return { success: true }
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
    // chat_messages (см. src/lib/greenapi/bot-reply.ts).
    const phone = deal.external_key.slice('greenapi:'.length)
    const admin = createAdminClient()
    const { data: rows } = await admin
      .from('chat_messages')
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
    // Переписка WhatsApp-канала amoCRM живёт у нас (chat_messages,
    // миграция 041) — сервер мастер истории, см. src/lib/greenapi/bot-reply.ts.
    const leadId = deal.external_key.slice('amocrm:'.length)
    // Системная история чата не принадлежит конкретному сотруднику.
    // Авторизация уже проверена выше, поэтому читаем её admin-клиентом:
    // пользовательский RLS-клиент возвращал пусто.
    const admin = createAdminClient()
    const readStoredMessages = () => admin
      .from('chat_messages')
      .select('id, direction, sender, text, created_at')
      .eq('lead_id', leadId)
      .order('created_at')
      .order('id')
      .limit(200)
    const { data: rows } = await readStoredMessages()
    // Догрузки истории из amoCRM больше нет — интеграция снята. Уже
    // сохранённая переписка осталась на месте, новые сообщения пишет
    // Green API через вебхук.
    const messages = toDealMessages(rows)
    return { messages, note: messages.length ? null : 'Сообщений пока нет' }
  }

  return {
    messages: [],
    note: deal.external_key
      ? 'Переписки по этому каналу нет'
      : 'Сделка заведена вручную — переписки нет',
  }
}

// ─── Управление ботом в конкретном чате ─────────────────────────────
// Как только в чат вступил живой менеджер, бот больше не отвечает в нём —
// это правило по умолчанию. Тумблер в карточке сделки — явный override:
// «вернуть чат боту» действует до следующего сообщения менеджера в этом же
// чате (тогда управление снова у человека), см. isManagerControllingChat
// в src/lib/chat-control.ts.

export interface DealBotControl {
  /** null — у клиента нет номера, переключать нечего. */
  chatId: string | null
  managerControls: boolean
}

// Канал один — Green API (WhatsApp), и адресуется он номером телефона.
// Раньше тумблер искал чат по lead_id amoCRM; после отказа от amoCRM ключом
// стал сам номер клиента из сделки.
export async function getDealBotControl(dealId: string): Promise<DealBotControl> {
  const me = await getViewer()
  if (!me) return { chatId: null, managerControls: false }

  const supabase = await createClient()
  const { data } = await supabase
    .from('deals')
    .select('customer_phone')
    .eq('id', dealId)
    .maybeSingle()
  const phone = (data as { customer_phone: string | null } | null)?.customer_phone
  if (!phone) return { chatId: null, managerControls: false }

  return getChatControlStatus(phone)
}

export async function setDealBotControl(chatId: string, botEnabled: boolean): Promise<DealActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }
  if (!isAllowedChatControlRole(me.role)) return { success: false, error: 'Недостаточно прав' }
  try {
    const admin = createAdminClient()
    const { data: before } = await admin
      .from('chat_control')
      .select('bot_enabled')
      .eq('chat_id', chatId)
      .maybeSingle()

    await setChatBotEnabled(chatId, botEnabled, me.id)

    const beforeEnabled = (before as { bot_enabled?: boolean } | null)?.bot_enabled
    await recordAudit({
      action: 'update',
      resourceType: 'chat_control',
      resourceId: chatId,
      summary: `Управление ботом в чате ${chatId}: ${beforeEnabled ?? '—'} → ${botEnabled}`,
    })

    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Не удалось переключить управление' }
  }
}

// ─── Что клиент покупал ──────────────────────────────────────────────────────

/** Строка истории покупок в карточке сделки. */
export interface DealPurchase {
  id: string
  quantity: number | null
  total_amount: number | null
  currency: string
  status: string
  city: string | null
  summary: string | null
  created_at: string
}

/**
 * История покупок клиента для карточки сделки. Заказ привязан к сделке
 * через orders.deal_id, но бот заводит заказ и по клиентам, у которых
 * сделка появилась отдельно (другой канал, ручное заведение) — поэтому
 * добираем ещё и по номеру телефона: телефон здесь и есть клиент.
 */
export async function getDealPurchases(dealId: string): Promise<DealPurchase[]> {
  const me = await getViewer()
  if (!me) return []

  const supabase = await createClient()
  const { data: deal } = await supabase
    .from('deals')
    .select('customer_phone')
    .eq('id', dealId)
    .maybeSingle()

  const phone = (deal as { customer_phone?: string | null } | null)?.customer_phone?.replace(/\D/g, '') ?? ''
  // last4/last9 — номера у нас лежат в разном формате (996…, 0…, +996…),
  // поэтому сравниваем по хвосту, как это делают рассылки.
  const tail = phone.slice(-9)

  const filters = [`deal_id.eq.${dealId}`]
  if (tail) filters.push(`customer_phone.like.%${tail}`)

  const { data } = await supabase
    .from('orders')
    .select('id, quantity, total_amount, currency, status, city, summary, created_at')
    .or(filters.join(','))
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(50)

  return (data ?? []) as DealPurchase[]
}
