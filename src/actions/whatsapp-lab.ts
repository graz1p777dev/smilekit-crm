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
  CITY_WAIT_ANCHOR_ID_PREFIX,
  FOLLOWUP_ANCHOR_ID_PREFIX,
  FOLLOWUP_CTA_ID_PREFIX,
  IDLE_NUDGE_ID_PREFIX,
  nextDiscountOffer,
  nextIdleNudgeReply,
  ORDER_CHECKLIST_VARIANTS,
  processInboundGreenApiMessage,
  sendResultsPhotoOnly,
} from '@/lib/greenapi/bot-reply'
import { DEFAULT_DOUBT_RESULT_REPLY, DEFAULT_FIRST_USE_EFFECT } from '@/lib/greenapi/default-templates'
import { requireOwner } from '@/actions/whatsapp-settings'

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
    // результата, лестница скидок), их защищённая функция — не дать боту
    // повторить блок дважды. Клиенту они никогда не уходят, поэтому в
    // истории теста показывать их не нужно — иначе кажется, что бот
    // отправил лишнее фото, которого на самом деле не было.
    .filter((row) => !row.amo_message_id.startsWith('ga:claim:'))
    .map((row) => ({
      sender: row.sender as 'client' | 'bot',
      text: row.text,
      createdAt: row.created_at,
      // Живой баг: чек-лист оформления рандомизирован (ORDER_CHECKLIST_VARIANTS,
      // 4 варианта текста), а раньше isVoice сверялся только с одним дефолтным —
      // в 3 случаях из 4 голосовое в проде уходило верно, а в «Лаборатории»
      // показывалось как обычный текст, будто голосовое не отправилось.
      isVoice:
        row.text === DEFAULT_FIRST_USE_EFFECT ||
        row.text === DEFAULT_DOUBT_RESULT_REPLY ||
        row.text === '[голосовое: пояснение по оплате]' ||
        ORDER_CHECKLIST_VARIANTS.includes(row.text),
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
  // Живой баг: этот сценарий гоняет РЕАЛЬНЫЙ пайплайн (обращения к ИИ,
  // реальные расходы), а проверки прав тут не было вообще — в отличие от
  // /dashboard/whatsapp-settings, где владелец редактирует те же промпты.
  // Любой залогиненный сотрудник (не только owner) мог дёргать эту функцию.
  if (!(await requireOwner())) return { success: false, error: 'Доступно только владельцу' }
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
 * Дожим — клиент молчит после ЛЮБОГО последнего ответа бота, на любом
 * этапе диалога. Тоже фон (followup-scheduler.ts), в песочнице реальные
 * час/сутки ждать негде. Каждый клик — следующий шаг цепочки: та же
 * логика, что и в проде (nextIdleNudgeReply) — вариант дожима не
 * повторяется, а если последним уже был дожим без ответа — сразу скидка.
 */
export async function triggerWhatsappLabIdleNudge(chatId: string): Promise<SendWhatsappLabMessageResult> {
  if (!(await requireOwner())) return { success: false, error: 'Доступно только владельцу' }
  const supabase = createAdminClient()
  const { data: last } = await supabase
    .from('amocrm_messages')
    .select('id, sender, text, amo_message_id')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const lastRow = last as { id: number; sender: string; text: string; amo_message_id: string } | null
  // Якорь после вопроса про город — в проде через 5 минут молчания уходит
  // блок «до/после» без доставки/голосового (followup-scheduler.ts); здесь —
  // по клику.
  if (lastRow && lastRow.amo_message_id.startsWith(`${CITY_WAIT_ANCHOR_ID_PREFIX}:`)) {
    await sendResultsPhotoOnly(supabase, chatId, { dryRun: true })
    return { success: true, chatId, history: await loadHistory(chatId) }
  }
  // Якорь после блока результата — в проде через 5 минут молчания уходит
  // CTA «вам оформить со скидкой?» (реальная скидка 13%, nextDiscountOffer;
  // followup-scheduler.ts); здесь — по клику.
  if (lastRow && lastRow.amo_message_id.startsWith(`${FOLLOWUP_ANCHOR_ID_PREFIX}:`)) {
    const discountCta = await nextDiscountOffer(supabase, chatId)
    await supabase.from('amocrm_messages').upsert({
      amo_message_id: `${FOLLOWUP_CTA_ID_PREFIX}:lab:${lastRow.id}`,
      chat_id: chatId,
      direction: 'out',
      sender: 'bot',
      text: discountCta,
    }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
    return { success: true, chatId, history: await loadHistory(chatId) }
  }
  if (!lastRow || lastRow.sender !== 'bot' || lastRow.amo_message_id.startsWith('ga:claim:')) {
    return {
      success: false,
      error: 'Дожим сейчас не сработает: бот ждёт ответа клиента или ещё ничего не отвечал.',
    }
  }
  const replyText = await nextIdleNudgeReply(supabase, chatId, lastRow.text, lastRow.amo_message_id)
  if (!replyText) {
    return {
      success: false,
      error: 'Больше предложить нечего: максимальная скидка уже озвучена, дальше бот молчит.',
    }
  }
  await supabase.from('amocrm_messages').upsert({
    amo_message_id: `${IDLE_NUDGE_ID_PREFIX}:lab:${lastRow.id}`,
    chat_id: chatId,
    direction: 'out',
    sender: 'bot',
    text: replyText,
  }, { onConflict: 'amo_message_id', ignoreDuplicates: true })

  const history = await loadHistory(chatId)
  return { success: true, chatId, history }
}
