// Продвижение сделки по воронке по сигналам Telegram-бота SmileKit.
//
// Бот (bot/smilekit_bot/crm.py, stage_action_for_inbound) на каждое сообщение
// клиента определяет намерение и шлёт PATCH /api/internal/deals с action.
// Здесь action превращается в конкретный deal_stages.id.
//
// status и deal_events заполняет БД-триггер
// (trg_deals_sync_stage_state / trg_deals_log_stage_change,
// supabase/migrations/036_deals.sql) — здесь их не трогаем. Суммой и составом
// заказа сделку не обновляем: это отдельная таблица orders
// (src/lib/orders/ingest.ts), которая подхватывает deal_id сама.

import { createAdminClient } from '@/lib/supabase/admin'
import { recordEvent } from '@/lib/control-center'

/** action → название этапа (supabase/migrations/036_deals.sql, 039_...sql). */
const ACTION_STAGE_NAME: Record<string, string> = {
  primary_contact: 'Заявка получена',
  need_identified: 'Потребность выявлена',
  interest_confirmed: 'Интерес подтверждён',
  ready_to_buy: 'Готов к покупке',
  order: 'Передан менеджеру',
  non_standard_request: 'Нестандартный запрос',
}

// non_standard_request — не шаг воронки «к покупке», а сигнал разобраться
// человеку (жалоба/возврат/сотрудничество): сделка может быть на любом этапе,
// когда это случится, поэтому только для этого action правило «только вперёд»
// не применяется.
const BYPASS_FORWARD_ONLY = new Set(['non_standard_request'])

export interface AdvanceDealResult {
  ok: boolean
  id?: string
  skipped?: 'not_found' | 'terminal' | 'unknown_action' | 'no_change'
  error?: string
}

export async function advanceDealFromBotAction(
  externalKey: string,
  action: string
): Promise<AdvanceDealResult> {
  const targetStageName = ACTION_STAGE_NAME[action]
  if (!targetStageName) return { ok: false, skipped: 'unknown_action' }

  const key = externalKey.trim()
  if (!key) return { ok: false, error: 'externalKey пустой' }

  const supabase = createAdminClient()

  const { data: deal, error: dealError } = await supabase
    .from('deals')
    .select('id, stage_id, status')
    .eq('external_key', key)
    .is('deleted_at', null)
    .maybeSingle()
  if (dealError) return { ok: false, error: dealError.message }
  if (!deal) return { ok: false, skipped: 'not_found' }
  const d = deal as { id: string; stage_id: string; status: string }

  // Сделку, которую менеджер уже закрыл (выиграна/потеряна), бот не трогает.
  if (d.status !== 'open') return { ok: true, skipped: 'terminal' }

  const { data: currentStage, error: currentStageError } = await supabase
    .from('deal_stages')
    .select('sort_order')
    .eq('id', d.stage_id)
    .maybeSingle()
  if (currentStageError) return { ok: false, error: currentStageError.message }

  const { data: targetStage, error: targetStageError } = await supabase
    .from('deal_stages')
    .select('id, sort_order')
    .eq('name', targetStageName)
    .maybeSingle()
  if (targetStageError) return { ok: false, error: targetStageError.message }
  if (!targetStage) return { ok: false, error: `Этап "${targetStageName}" не найден` }
  const target = targetStage as { id: string; sort_order: number }

  // Воронка двигается только вперёд — повторное распознанное намерение
  // (например клиент второй раз спросил про товар) не откатывает сделку.
  // Исключение — non_standard_request (см. BYPASS_FORWARD_ONLY выше).
  if (
    !BYPASS_FORWARD_ONLY.has(action) &&
    currentStage &&
    target.sort_order <= (currentStage as { sort_order: number }).sort_order
  ) {
    return { ok: true, id: d.id, skipped: 'no_change' }
  }

  const { error: updateError } = await supabase
    .from('deals')
    .update({ stage_id: target.id })
    .eq('id', d.id)
  if (updateError) return { ok: false, error: updateError.message }

  recordEvent({ type: 'deal', level: 'info', title: 'Deal advanced', payload: { dealId: d.id } })
  return { ok: true, id: d.id }
}
