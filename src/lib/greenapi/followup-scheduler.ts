// Дожим клиента, если он молчит — две волны, как в обычной рассылке:
// 1. Через 1 час после ЛЮБОГО последнего ответа бота (на любом этапе
//    диалога) — обычный дожим, вариант ротируется (see bot-reply.ts:
//    IDLE_NUDGE_VARIANTS/nextIdleNudgeReply), не повторяет один и тот же
//    текст при разных периодах молчания в одном чате.
// 2. Если клиент так и не ответил ещё 24 часа ПОСЛЕ этого дожима — вторая
//    волна сразу предлагает скидку по лестнице (13%→20%), не повторяет
//    первый дожим.
// Если последним бот предложил скидку 13% (по любому поводу — прямая
// просьба, отказ на CTA) и клиент молчит 1 час — дожим сразу эскалирует до
// 20%, не дожидаясь второй волны.
//
// Как только клиент отвечает — цепочка сбрасывается сама: последняя
// запись в чате становится его сообщением, и до следующего ответа бота
// дожим не считается снова.
//
// Тот же паттерн, что campaigns/scheduler.ts и amocrm/outgoing-poller.ts:
// in-process setInterval, один инстанс на Railway — дублей нет.

import { createAdminClient } from '@/lib/supabase/admin'
import { sendGreenApiMessage } from '@/lib/greenapi/client'
import {
  canSendGreenApiBotReply,
  IDLE_NUDGE_ID_PREFIX,
  nextIdleNudgeReply,
} from '@/lib/greenapi/bot-reply'

const TICK_INTERVAL_MS = 60_000
const NUDGE_SILENCE_MS = 60 * 60_000
const SECOND_WAVE_SILENCE_MS = 24 * 3600_000

let started = false

export function startFollowupScheduler(): void {
  if (started) return
  started = true
  console.log('greenapi followup scheduler started')
  const tick = () => {
    void runOnce().catch((error) => console.error('greenapi followup scheduler failed', error))
  }
  tick()
  setInterval(tick, TICK_INTERVAL_MS).unref?.()
}

async function sendStageReply(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string,
  lastId: number,
  replyText: string,
  messageIdPrefix: string
): Promise<void> {
  if (!(await canSendGreenApiBotReply(supabase, chatId))) return

  const botMessageId = `${messageIdPrefix}:${lastId}`
  const { error: reserveError } = await supabase.from('amocrm_messages').upsert({
    amo_message_id: botMessageId,
    chat_id: chatId,
    direction: 'out',
    sender: 'bot',
    text: replyText,
  }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
  if (reserveError) {
    console.error('greenapi followup scheduler: reserve failed', reserveError.message)
    return
  }
  try {
    await sendGreenApiMessage(`${chatId}@c.us`, replyText)
  } catch (error) {
    await supabase.from('amocrm_messages').delete().eq('amo_message_id', botMessageId)
    console.error('greenapi followup scheduler: send failed', error)
  }
}

/**
 * Клиент молчит после последнего реального ответа бота, на любом этапе
 * диалога. Служебные маркеры (ga:claim:*) в счёт не идут — это не реальный
 * ответ клиенту, а внутренняя защёлка. Порог зависит от того, было ли
 * последнее сообщение уже дожимом (24 часа) или обычным ответом (1 час).
 */
async function processIdleNudgeStage(supabase: ReturnType<typeof createAdminClient>): Promise<void> {
  const cutoff = new Date(Date.now() - NUDGE_SILENCE_MS).toISOString()
  const { data: candidates } = await supabase
    .from('amocrm_messages')
    .select('chat_id')
    .eq('sender', 'bot')
    .not('amo_message_id', 'like', 'ga:claim:%')
    .lte('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(200)
  if (!candidates?.length) return

  const chatIds = [...new Set((candidates as { chat_id: string }[]).map((row) => row.chat_id))]
  for (const chatId of chatIds) {
    const { data: last } = await supabase
      .from('amocrm_messages')
      .select('id, sender, text, amo_message_id, created_at')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const lastRow = last as
      | { id: number; sender: string; text: string; amo_message_id: string; created_at: string }
      | null
    if (!lastRow || lastRow.sender !== 'bot') continue // клиент уже ответил
    if (lastRow.amo_message_id.startsWith('ga:claim:')) continue // технический маркер, не реальный ответ

    const alreadyNudged = lastRow.amo_message_id.startsWith(IDLE_NUDGE_ID_PREFIX)
    const requiredSilenceMs = alreadyNudged ? SECOND_WAVE_SILENCE_MS : NUDGE_SILENCE_MS
    if (new Date(lastRow.created_at).getTime() > Date.now() - requiredSilenceMs) continue // порог ещё не прошёл

    const replyText = await nextIdleNudgeReply(supabase, chatId, lastRow.text, lastRow.amo_message_id)
    if (!replyText) continue // больше предложить нечего — не пишем
    await sendStageReply(supabase, chatId, lastRow.id, replyText, IDLE_NUDGE_ID_PREFIX)
  }
}

async function runOnce(): Promise<void> {
  const supabase = createAdminClient()
  await processIdleNudgeStage(supabase)
}
