'use server'

// Песочница для теста WhatsApp-канала (Green API): в отличие от
// /dashboard/laboratory (тестирует только AI-ядро менеджер+супервизор без
// сценариев), здесь гоняется РЕАЛЬНЫЙ пайплайн bot-reply.ts — тот же самый
// код, что обрабатывает настоящие сообщения клиентов: скрипт продаж, блок
// результата с фото, доставка по городу, QR оплаты, свои правила из
// настроек, follow-up-скидка. Отличия от прода — только opts:
// skipIntegrationCheck (не завязано на общий аварийный выключатель бота —
// можно тестировать, даже когда бот выключен для реальных клиентов) и
// dryRun (ничего не уходит в реальный Green API и не создаёт сделки в
// воронке — тестовый chat_id никогда не пересекается с настоящими номерами).

import { randomUUID } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  FOLLOWUP_ANCHOR_TEXT,
  ORDER_CTA_FOLLOWUP_TEXT,
  processInboundGreenApiMessage,
} from '@/lib/greenapi/bot-reply'
import { DEFAULT_DOUBT_RESULT_REPLY, DEFAULT_FIRST_USE_EFFECT } from '@/lib/greenapi/default-templates'

export interface WhatsappLabMessage {
  sender: 'client' | 'bot'
  text: string
  createdAt: string
  isVoice: boolean
}

function newLabChatId(): string {
  // Префикс гарантирует, что тестовый чат никогда не совпадёт с реальным
  // номером телефона (chat_id в проде — только цифры).
  return `lab-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

async function loadHistory(chatId: string): Promise<WhatsappLabMessage[]> {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('amocrm_messages')
    .select('amo_message_id, sender, text, created_at')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true })
    .limit(200)
  return (data ?? [])
    .map((row) => row as { amo_message_id: string; sender: string; text: string; created_at: string })
    .filter((row) => row.sender === 'client' || row.sender === 'bot')
    // ga:claim:* — служебные строки-защёлки (одноразовый захват блока
    // результата, follow-up-якорь), их защищённая функция — не дать боту
    // повторить блок дважды. Клиенту они никогда не уходят, поэтому в
    // истории теста показывать их не нужно — иначе кажется, что бот
    // отправил лишнее фото, которого на самом деле не было.
    .filter((row) => !row.amo_message_id.startsWith('ga:claim:'))
    .map((row) => ({
      sender: row.sender as 'client' | 'bot',
      text: row.text,
      createdAt: row.created_at,
      isVoice: row.text === DEFAULT_FIRST_USE_EFFECT || row.text === DEFAULT_DOUBT_RESULT_REPLY,
    }))
}

export type SendWhatsappLabMessageResult =
  | { success: true; chatId: string; history: WhatsappLabMessage[] }
  | { success: false; error: string }

/** chatId — undefined на первом сообщении новой сессии, дальше приходит от клиента. */
export async function sendWhatsappLabMessage(
  chatId: string | undefined,
  text: string
): Promise<SendWhatsappLabMessageResult> {
  const trimmed = text.trim()
  if (!trimmed) return { success: false, error: 'Введите сообщение' }

  const effectiveChatId = chatId || newLabChatId()
  try {
    await processInboundGreenApiMessage(
      {
        providerMessageId: `lab:${randomUUID()}`,
        chatId: effectiveChatId,
        authorName: 'Тест (Лаборатория)',
        text: trimmed,
        messageType: 'text',
        mediaUrl: null,
      },
      { skipIntegrationCheck: true, dryRun: true }
    )
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Ошибка бота' }
  }

  const history = await loadHistory(effectiveChatId)
  return { success: true, chatId: effectiveChatId, history }
}

/**
 * В реальном WhatsApp этот вопрос уходит только через 5 минут молчания
 * клиента — followup-scheduler.ts проверяет это раз в минуту фоном (см.
 * bot-reply.ts: needsFollowupAnchor/FOLLOWUP_ANCHOR_TEXT). В песочнице
 * ждать реальные 5 минут негде, поэтому кнопка «промотать» повторяет ту же
 * проверку по требованию для одного тестового чата, без порога по времени.
 */
export async function triggerWhatsappLabFollowup(chatId: string): Promise<SendWhatsappLabMessageResult> {
  const supabase = createAdminClient()
  const { data: last } = await supabase
    .from('amocrm_messages')
    .select('id, sender, text')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const lastRow = last as { id: number; sender: string; text: string } | null
  if (!lastRow || lastRow.sender !== 'bot' || lastRow.text !== FOLLOWUP_ANCHOR_TEXT) {
    return {
      success: false,
      error: 'Follow-up сейчас не сработает: бот ждёт ответа клиента или ещё не показывал блок результата.',
    }
  }
  await supabase.from('amocrm_messages').upsert({
    amo_message_id: `ga:bot:followup:lab:${lastRow.id}`,
    chat_id: chatId,
    direction: 'out',
    sender: 'bot',
    text: ORDER_CTA_FOLLOWUP_TEXT,
  }, { onConflict: 'amo_message_id', ignoreDuplicates: true })

  const history = await loadHistory(chatId)
  return { success: true, chatId, history }
}
