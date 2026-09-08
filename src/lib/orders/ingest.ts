// Приём заказа из Telegram-бота Smilekit.
//
// Единственный вход в public.orders снаружи сессии сотрудника: бот не имеет и
// не должен иметь SUPABASE_SERVICE_ROLE_KEY, поэтому зовёт
// POST /api/internal/orders с общим секретом, а RLS обходит уже здесь —
// заказ создаёт система, а не сотрудник.
//
// Идемпотентность держится на UNIQUE orders.external_key: повторная
// отправка того же заказа (ретрай, повторное подтверждение клиентом)
// не создаёт вторую строку.
//
// ВАЖНО: вход не доверенный. Токен подтверждает только «это наш бот», но не
// то, что модель прислала осмысленные числа, — всё, что приходит, режется по
// длине и диапазону здесь, до вставки.

import { createAdminClient } from '@/lib/supabase/admin'
import { notify } from '@/lib/notifications/notify'
import { recordEvent } from '@/lib/control-center'
import type { OrderCurrency, OrderSource } from '@/types'

const CURRENCIES: readonly OrderCurrency[] = ['KGS', 'USD', 'RUB']
const SOURCES: readonly OrderSource[] = ['telegram_bot', 'manual']

/** Потолок для NUMERIC(12,2) с запасом: заведомо больше любого реального заказа. */
const MAX_MONEY = 99_999_999
const MAX_QUANTITY = 1000

export interface InboundOrder {
  externalKey: string
  source?: string | null
  customerName?: string | null
  customerPhone?: string | null
  customerUsername?: string | null
  telegramChatId?: number | string | null
  quantity?: number | string | null
  unitPrice?: number | string | null
  totalAmount?: number | string | null
  currency?: string | null
  city?: string | null
  summary?: string | null
}

export interface IngestOrderResult {
  created: boolean
  id: string | null
  error?: string
}

// ─── Нормализация ────────────────────────────────────────────────────────────
// Всё, чего не удалось разобрать, становится null: пустое поле менеджер
// доспросит у клиента, а придуманное — уведёт его не туда.

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function money(value: unknown): number | null {
  const num = typeof value === 'string' ? Number(value.replace(',', '.')) : value
  if (typeof num !== 'number' || !Number.isFinite(num) || num < 0) return null
  return Math.round(Math.min(num, MAX_MONEY) * 100) / 100
}

function quantity(value: unknown): number | null {
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num !== 'number' || !Number.isFinite(num)) return null
  const int = Math.trunc(num)
  if (int < 1) return null
  return Math.min(int, MAX_QUANTITY)
}

function chatId(value: unknown): number | null {
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num !== 'number' || !Number.isInteger(num)) return null
  if (!Number.isSafeInteger(num)) return null
  return num
}

export interface NormalizedOrder {
  external_key: string
  source: OrderSource
  customer_name: string | null
  customer_phone: string | null
  customer_username: string | null
  telegram_chat_id: number | null
  quantity: number | null
  unit_price: number | null
  total_amount: number | null
  currency: OrderCurrency
  city: string | null
  summary: string | null
}

export function normalizeOrder(input: InboundOrder): NormalizedOrder | null {
  const key = text(input.externalKey, 200)
  if (!key) return null

  const currency = CURRENCIES.includes(input.currency as OrderCurrency)
    ? (input.currency as OrderCurrency)
    : 'KGS'
  const source = SOURCES.includes(input.source as OrderSource)
    ? (input.source as OrderSource)
    : 'telegram_bot'

  const qty = quantity(input.quantity)
  const unit = money(input.unitPrice)
  // Сумму НЕ достраиваем из прайса: цена коробки в диалоге обсуждаема, и
  // qty × 1490 показало бы менеджеру сумму, о которой с клиентом никто не
  // договаривался. Считаем только по цене, которую прислали явно; иначе
  // сумма остаётся пустой и её уточняет менеджер.
  const total = money(input.totalAmount) ?? (qty !== null && unit !== null ? qty * unit : null)

  return {
    external_key: key,
    source,
    customer_name: text(input.customerName, 200),
    customer_phone: text(input.customerPhone, 32),
    customer_username: text(input.customerUsername, 120),
    telegram_chat_id: chatId(input.telegramChatId),
    quantity: qty,
    unit_price: unit,
    total_amount: total === null ? null : Math.min(total, MAX_MONEY),
    currency,
    city: text(input.city, 120),
    summary: text(input.summary, 4000),
  }
}

/** Короткая строка состава для заголовка уведомления. */
export function orderHeadline(order: NormalizedOrder): string {
  const parts: string[] = []
  if (order.quantity !== null) parts.push(`${order.quantity} кор.`)
  if (order.total_amount !== null) {
    parts.push(`${order.total_amount.toLocaleString('ru-RU')} ${order.currency}`)
  }
  if (order.city) parts.push(order.city)
  return parts.length ? parts.join(' · ') : 'состав уточняется'
}

// ─── Приём ───────────────────────────────────────────────────────────────────

/**
 * Создаёт заказ, если его ещё нет. Существующий не трогает: менеджер мог
 * уже поправить количество и адрес после разговора с клиентом, и повторный
 * пуш от бота не должен затирать эту правку.
 */
export async function ingestOrder(input: InboundOrder): Promise<IngestOrderResult> {
  const order = normalizeOrder(input)
  if (!order) return { created: false, id: null, error: 'external_key пустой' }

  const supabase = createAdminClient()

  const { data: existing } = await supabase
    .from('orders')
    .select('id')
    .eq('external_key', order.external_key)
    .maybeSingle()
  if (existing) return { created: false, id: (existing as { id: string }).id }

  // Сделку по этому диалогу не создаём — только подхватываем, если модуль
  // сделок её уже завёл по ключу диалога telegram:<chat_id>.
  let dealId: string | null = null
  if (order.telegram_chat_id !== null) {
    const { data: deal } = await supabase
      .from('deals')
      .select('id')
      .eq('external_key', `telegram:${order.telegram_chat_id}`)
      .is('deleted_at', null)
      .maybeSingle()
    dealId = (deal as { id: string } | null)?.id ?? null
  }

  // ignoreDuplicates — два ретрая подряд не должны падать 23505.
  const { data: inserted, error } = await supabase
    .from('orders')
    .upsert({ ...order, deal_id: dealId }, { onConflict: 'external_key', ignoreDuplicates: true })
    .select('id')

  if (error) return { created: false, id: null, error: error.message }

  // Если бот уже узнал город при оформлении, показываем его и в сделке.
  // Ручное значение менеджера не перезаписываем.
  if (dealId && order.city) {
    await supabase
      .from('deals')
      .update({ city: order.city })
      .eq('id', dealId)
      .is('city', null)
  }

  const row = (inserted ?? [])[0] as { id: string } | undefined
  if (!row) {
    // Гонка: строку успел вставить параллельный запрос. Заказ есть — это успех.
    const { data: raced } = await supabase
      .from('orders')
      .select('id')
      .eq('external_key', order.external_key)
      .maybeSingle()
    return { created: false, id: (raced as { id: string } | null)?.id ?? null }
  }

  // Уведомление менеджерам. notify() не бросает наружу — заказ уже создан,
  // и провал уведомления не должен превратиться в ошибку для бота.
  const who = order.customer_name || order.customer_username || order.customer_phone || 'Клиент'
  await notify({
    type: 'order_new',
    title: `Новый заказ: ${who}`,
    body: orderHeadline(order),
    actionUrl: `/dashboard/orders?order=${row.id}`,
    isImportant: true,
    sourceType: 'order',
    sourceId: row.id,
  })

  recordEvent({ type: 'order', level: 'info', title: 'Order ingested', payload: { orderId: row.id } })
  return { created: true, id: row.id }
}
