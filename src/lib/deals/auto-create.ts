// Автосоздание сделки по входящему сообщению клиента.
//
// Один вход для всех каналов: push от витрины (/api/internal/deals),
// вебхук Wazzup (/api/whatsapp/webhook) и сверка со витриной
// (reconcileDealsFromShop в src/actions/deals.ts).
//
// ВАЖНО: только серверный код — здесь service-role клиент. Все три вызова
// приходят снаружи сессии пользователя (бот, вебхук), поэтому RLS обойти
// приходится: сделку создаёт система, а не сотрудник.
//
// Идемпотентность держится на UNIQUE deals.external_key: повторное
// сообщение того же клиента не создаёт вторую сделку.

import { createAdminClient } from '@/lib/supabase/admin'
import { recordEvent } from '@/lib/control-center'
import type { DealSource } from '@/types'

export interface InboundDeal {
  /** Стабильный ключ клиента в канале: telegram:<chat_id>, wazzup:<phone>. */
  externalKey: string
  source: DealSource
  customerName?: string | null
  customerPhone?: string | null
  customerUsername?: string | null
  city?: string | null
  address?: string | null
}

const SOURCE_FALLBACK: Record<DealSource, string> = {
  telegram: 'Клиент из Telegram',
  whatsapp: 'Клиент из WhatsApp',
  instagram: 'Клиент из Instagram',
  site: 'Клиент с сайта',
  manual: 'Клиент',
  amocrm: 'Клиент из amoCRM',
}

/** Заголовок сделки: имя → username → телефон → канал. Пустым не бывает. */
export function dealTitleFor(input: InboundDeal): string {
  const candidates = [input.customerName, input.customerUsername, input.customerPhone]
  for (const value of candidates) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed.slice(0, 300)
  }
  return SOURCE_FALLBACK[input.source]
}

export interface UpsertDealResult {
  created: boolean
  id: string | null
  error?: string
}

/**
 * Создаёт сделку в этапе по умолчанию («Неразобранное»), если её ещё нет.
 * Существующую не трогает — менеджер мог уже изменить заголовок и сумму.
 */
export async function upsertDealFromInbound(input: InboundDeal): Promise<UpsertDealResult> {
  const key = input.externalKey.trim()
  if (!key) return { created: false, id: null, error: 'external_key пустой' }

  const supabase = createAdminClient()

  const { data: existing } = await supabase
    .from('deals')
    .select('id')
    .eq('external_key', key)
    .maybeSingle()
  if (existing) return { created: false, id: (existing as { id: string }).id }

  const { data: stage, error: stageError } = await supabase
    .from('deal_stages')
    .select('id')
    .eq('is_default', true)
    .maybeSingle()
  if (stageError || !stage) {
    return { created: false, id: null, error: 'Не найден этап по умолчанию' }
  }

  // ignoreDuplicates — гонка двух сообщений подряд не должна падать 23505.
  const { data: inserted, error } = await supabase
    .from('deals')
    .upsert(
      {
        title: dealTitleFor(input),
        stage_id: (stage as { id: string }).id,
        source: input.source,
        external_key: key,
        customer_name: input.customerName?.trim() || null,
        customer_phone: input.customerPhone?.trim() || null,
        customer_username: input.customerUsername?.trim() || null,
        city: input.city?.trim().slice(0, 120) || null,
        address: input.address?.trim().slice(0, 500) || null,
      },
      { onConflict: 'external_key', ignoreDuplicates: true }
    )
    .select('id')

  if (error) return { created: false, id: null, error: error.message }

  const row = (inserted ?? [])[0] as { id: string } | undefined
  if (row) {
    recordEvent({ type: 'deal', level: 'info', title: 'Deal created', payload: { dealId: row.id } })
  }
  return { created: Boolean(row), id: row?.id ?? null }
}
