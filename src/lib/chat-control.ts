// Кто ведёт чат — бот или живой менеджер.
//
// Раньше это лежало в src/lib/amocrm/bot-reply.ts, хотя к amoCRM отношения
// не имеет: переключатель работает по переписке и таблице chat control, а
// канал теперь один — Green API (WhatsApp).
//
// Правило: чат считается «у менеджера», если в нём писал живой человек.
// Явная отметка в таблице перекрывает прошлые сообщения менеджера, но
// только до его следующего сообщения — написал снова, значит снова ведёт он.

import { createAdminClient } from '@/lib/supabase/admin'
import { BULK_BROADCAST_AUTHOR_MARKER } from '@/lib/greenapi/bot-reply'

export interface ChatControlStatus {
  chatId: string | null
  managerControls: boolean
}

export async function isManagerControllingChat(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string
): Promise<boolean> {
  const [lastOperatorResult, controlResult] = await Promise.all([
    // limit(20), не 1: часть последних «operator»-записей может быть
    // массовой рассылкой — её пропускаем, ищем ответ реального человека.
    supabase
      .from('chat_messages')
      .select('created_at, author_name')
      .eq('chat_id', chatId)
      .eq('sender', 'operator')
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('chat_control')
      .select('bot_enabled, updated_at')
      .eq('chat_id', chatId)
      .maybeSingle(),
  ])

  const lastGenuine = (
    lastOperatorResult.data as { created_at: string; author_name: string | null }[] | null
  )?.find((row) => row.author_name !== BULK_BROADCAST_AUTHOR_MARKER)
  const lastOperatorAt = lastGenuine?.created_at ? new Date(lastGenuine.created_at).getTime() : null

  const control = controlResult.data as { bot_enabled: boolean; updated_at: string } | null
  if (!control) return lastOperatorAt !== null
  const overrideIsFresh = lastOperatorAt === null || new Date(control.updated_at).getTime() > lastOperatorAt
  if (overrideIsFresh) return !control.bot_enabled
  return true
}

/** Статус чата для тумблера в карточке сделки. Ключ чата — номер телефона. */
export async function getChatControlStatus(chatId: string): Promise<ChatControlStatus> {
  const digits = chatId.replace(/\D/g, '')
  if (!digits) return { chatId: null, managerControls: false }
  const supabase = createAdminClient()
  return { chatId: digits, managerControls: await isManagerControllingChat(supabase, digits) }
}

/** true — вернуть чат боту, false — забрать управление менеджеру. */
export async function setChatBotEnabled(
  chatId: string,
  botEnabled: boolean,
  userId: string | null
): Promise<void> {
  const supabase = createAdminClient()
  const { error } = await supabase.from('chat_control').upsert(
    { chat_id: chatId, bot_enabled: botEnabled, updated_at: new Date().toISOString(), updated_by: userId },
    { onConflict: 'chat_id' }
  )
  if (error) throw new Error(`chat control upsert: ${error.message}`)
}
