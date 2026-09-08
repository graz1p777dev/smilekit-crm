// Настраиваемая часть WhatsApp-бота (шаблоны, куда слать заказы, товароучёт,
// внешние CRM) — хранится в settings.extra.smilekit_whatsapp. Отдельной
// таблицы нет: settings — уже существующий singleton-конфиг компании с
// JSONB-полем extra под ровно такие расширения, заводить миграцию под
// несколько строк текста избыточно.
//
// Читается на каждое сообщение (createAdminClient — один SELECT), пишется
// только из CRM. Это сознательный компромисс простоты: без кэша, зато без
// риска показать в UI не то, что реально применяется ботом.

import { createAdminClient } from '@/lib/supabase/admin'

export interface WhatsappTemplates {
  productInfo: string
  orderChecklist: string
  doubtResult: string
  firstUseEffect: string
  lowStockCta: string
  complaintPrompt: string
  cooperationReply: string
}

export interface OutboundWebhook {
  id: string
  name: string
  url: string
}

export interface CustomRule {
  id: string
  /** Regex (без флагов, регистр не важен — всегда 'i') по тексту клиента. */
  trigger: string
  reply: string
  /** Выключить не удаляя — быстро откатить правило без потери текста. */
  enabled: boolean
}

export interface WhatsappBotConfig {
  templates: Partial<WhatsappTemplates>
  /** Свои правила «условие → ответ», проверяются до основного скрипта продаж
   * и до ИИ — первое совпавшее enabled-правило выигрывает. */
  customRules: CustomRule[]
  deliveryGroupId: string | null
  /** Что и как форматировать при отправке подтверждённого заказа в группу. */
  deliveryPrompt: string | null
  /** Группа, куда бот передаёт клиента менеджеру после пост-результатной
   * цепочки дожима (CTA/«актуально?»/скидки) — см. bot-reply.ts
   * handOffToManager. */
  handoffGroupId: string | null
  /** Внешние системы (Bitrix и т.п.) — на них дублируются события заказов. */
  outboundWebhooks: OutboundWebhook[]
  stock: { quantity: number | null }
}

const DEFAULTS: WhatsappBotConfig = {
  templates: {},
  customRules: [],
  deliveryGroupId: null,
  deliveryPrompt: null,
  handoffGroupId: null,
  outboundWebhooks: [],
  stock: { quantity: null },
}

const SETTINGS_KEY = 'smilekit_whatsapp'

export async function getWhatsappBotConfig(): Promise<WhatsappBotConfig> {
  const admin = createAdminClient()
  const { data } = await admin.from('settings').select('id, extra').limit(1).maybeSingle()
  const extra = (data as { extra?: Record<string, unknown> } | null)?.extra ?? {}
  const stored = extra[SETTINGS_KEY] as Partial<WhatsappBotConfig> | undefined
  return {
    templates: stored?.templates ?? {},
    customRules: stored?.customRules ?? [],
    deliveryGroupId: stored?.deliveryGroupId ?? null,
    deliveryPrompt: stored?.deliveryPrompt ?? null,
    handoffGroupId: stored?.handoffGroupId ?? null,
    outboundWebhooks: stored?.outboundWebhooks ?? [],
    stock: stored?.stock ?? { quantity: null },
  }
}

export async function saveWhatsappBotConfig(patch: Partial<WhatsappBotConfig>): Promise<{ success: true } | { success: false; error: string }> {
  const admin = createAdminClient()
  const { data: row } = await admin.from('settings').select('id, extra').limit(1).maybeSingle()
  if (!row) return { success: false, error: 'Таблица settings пуста — компания не инициализирована' }
  const extra = ((row as { extra?: Record<string, unknown> }).extra ?? {}) as Record<string, unknown>
  const current = (extra[SETTINGS_KEY] ?? DEFAULTS) as WhatsappBotConfig
  const next = { ...current, ...patch }
  const { error } = await admin
    .from('settings')
    .update({ extra: { ...extra, [SETTINGS_KEY]: next } })
    .eq('id', (row as { id: string }).id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/**
 * Уменьшает остаток на quantity штук; не даёт уйти в минус.
 *
 * Живой баг: раньше это было обычное read-modify-write через
 * getWhatsappBotConfig/saveWhatsappBotConfig (оба независимо читают и
 * перезаписывают весь settings.extra) — два чека, подтвердившихся почти
 * одновременно, читали один и тот же остаток и оба писали `current - 1`,
 * теряя одно списание. Теперь пишем через compare-and-swap: UPDATE проходит,
 * только если extra с момента чтения не менялся (.eq('extra', ...)); если
 * кто-то успел вклиниться — не считаем это ошибкой, а перечитываем и
 * пробуем снова.
 */
export async function decrementStock(quantity: number): Promise<void> {
  const admin = createAdminClient()
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row } = await admin.from('settings').select('id, extra').limit(1).maybeSingle()
    if (!row) return
    const { id, extra: rawExtra } = row as { id: string; extra: Record<string, unknown> | null }
    const extra = rawExtra ?? {}
    const current = (extra[SETTINGS_KEY] as WhatsappBotConfig | undefined) ?? DEFAULTS
    const quantityNow = current.stock.quantity
    if (quantityNow === null) return // товароучёт не включён — ничего не считаем
    const nextExtra = {
      ...extra,
      [SETTINGS_KEY]: { ...current, stock: { quantity: Math.max(0, quantityNow - quantity) } },
    }
    const { data: updated, error } = await admin
      .from('settings')
      .update({ extra: nextExtra })
      .eq('id', id)
      .eq('extra', rawExtra as never)
      .select('id')
    if (error) {
      console.error('greenapi config: decrementStock failed', error.message)
      return
    }
    if (updated?.length) return // прошло без конфликта
    // extra изменился между чтением и записью (параллельный чек или правка
    // настроек) — перечитываем актуальное состояние и пробуем ещё раз.
  }
  console.error('greenapi config: decrementStock gave up after 5 attempts (contention)')
}
