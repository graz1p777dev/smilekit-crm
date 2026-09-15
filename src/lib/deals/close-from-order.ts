// Закрытие сделки по судьбе заказа.
//
// Бот доводит сделку максимум до «Передан менеджеру»: понять из переписки,
// что клиент окончательно отказался, он не может. Зато это однозначно видно
// по заказу, который менеджер ведёт на странице «Заказы»:
//   доставлен  → сделка выиграна;
//   отменён    → сделка проиграна.
//
// Сам статус сделки (won/lost) проставляет триггер БД по kind этапа
// (036_deals.sql) — здесь меняем только stage_id.

import { createAdminClient } from '@/lib/supabase/admin'

type Outcome = 'won' | 'lost'

const OUTCOME_BY_ORDER_STATUS: Record<string, Outcome | undefined> = {
  delivered: 'won',
  cancelled: 'lost',
}

/**
 * Двигает сделку заказа в терминальный этап. Ничего не делает, если заказ
 * не привязан к сделке, статус не терминальный или подходящего этапа в
 * воронке нет — молча, потому что это фоновое следствие, а не действие
 * пользователя: падать из-за него сохранение заказа не должно.
 */
export async function closeDealForOrder(orderId: string, orderStatus: string): Promise<void> {
  const outcome = OUTCOME_BY_ORDER_STATUS[orderStatus]
  if (!outcome) return

  const admin = createAdminClient()

  const { data: order } = await admin
    .from('orders')
    .select('deal_id, customer_phone')
    .eq('id', orderId)
    .maybeSingle()
  const row = order as { deal_id: string | null; customer_phone: string | null } | null

  // Заказ может быть не привязан к сделке — тогда ищем её по номеру.
  let dealId = row?.deal_id ?? null
  if (!dealId) {
    const tail = (row?.customer_phone ?? '').replace(/\D/g, '').slice(-9)
    if (!tail) return
    const { data: deal } = await admin
      .from('deals')
      .select('id')
      .like('customer_phone', `%${tail}`)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle()
    dealId = (deal as { id: string } | null)?.id ?? null
  }
  if (!dealId) return

  const { data: stage } = await admin
    .from('deal_stages')
    .select('id')
    .eq('kind', outcome)
    .order('sort_order')
    .limit(1)
    .maybeSingle()
  const stageId = (stage as { id: string } | null)?.id
  if (!stageId) return

  await admin
    .from('deals')
    .update({ stage_id: stageId })
    .eq('id', dealId)
    .is('deleted_at', null)
}
