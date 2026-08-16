// Два дожима, если клиент молчит:
// 1. Через 5 минут после блока результата — вопрос «вам оформить?»
//    (FOLLOWUP_ANCHOR_TEXT -> ORDER_CTA_FOLLOWUP_TEXT).
// 2. Через 1 час после ЛЮБОГО последнего ответа бота на любом этапе
//    диалога, если клиент так и не написал, — общее напоминание
//    (see bot-reply.ts: IDLE_NUDGE_TEXT). Как idle_nudge в Telegram-боте,
//    только порог 1 час вместо 30 минут.
// Раньше скидка 13% уходила сразу вместе с фото — теперь только вопрос
// через 5 минут, а скидка (в обычной обработке входящих, bot-reply.ts) —
// лишь если клиент ответит «нет».
//
// Тот же паттерн, что campaigns/scheduler.ts и amocrm/outgoing-poller.ts:
// in-process setInterval, один инстанс на Railway — дублей нет.

import { createAdminClient } from '@/lib/supabase/admin'
import { sendGreenApiMessage } from '@/lib/greenapi/client'
import {
  canSendGreenApiBotReply,
  FOLLOWUP_ANCHOR_TEXT,
  IDLE_NUDGE_TEXT,
  ORDER_CTA_FOLLOWUP_TEXT,
} from '@/lib/greenapi/bot-reply'

const TICK_INTERVAL_MS = 60_000
const FOLLOWUP_SILENCE_MS = 5 * 60_000
const IDLE_NUDGE_SILENCE_MS = 60 * 60_000

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
 * Стадия 1: FOLLOWUP_ANCHOR_TEXT — якорь-маркер (не отправляется клиенту),
 * ставится ровно один раз сразу после блока результата. Актуален, только
 * если это ПОСЛЕДНЯЯ запись в чате — любое следующее сообщение (ответ
 * клиента или уже отправленный вопрос) снимает триггер естественно, без
 * отдельного флага «отправлено».
 */
async function processFollowupStage(supabase: ReturnType<typeof createAdminClient>): Promise<void> {
  const cutoff = new Date(Date.now() - FOLLOWUP_SILENCE_MS).toISOString()
  const { data: anchors } = await supabase
    .from('amocrm_messages')
    .select('id, chat_id')
    .eq('sender', 'bot')
    .eq('text', FOLLOWUP_ANCHOR_TEXT)
    .lte('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(200)
  if (!anchors?.length) return

  for (const anchor of anchors as { id: number; chat_id: string }[]) {
    const { data: last } = await supabase
      .from('amocrm_messages')
      .select('id')
      .eq('chat_id', anchor.chat_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if ((last as { id?: number } | null)?.id !== anchor.id) continue
    await sendStageReply(supabase, anchor.chat_id, anchor.id, ORDER_CTA_FOLLOWUP_TEXT, 'ga:bot:followup')
  }
}

/**
 * Стадия 2: общий дожим — клиент молчит 1 час после ЛЮБОГО последнего
 * реального ответа бота, на любом этапе диалога (не только после
 * follow-up). Служебные маркеры (ga:claim:*) в счёт не идут — это не
 * реальный ответ клиенту, а внутренняя защёлка.
 */
async function processIdleNudgeStage(supabase: ReturnType<typeof createAdminClient>): Promise<void> {
  const cutoff = new Date(Date.now() - IDLE_NUDGE_SILENCE_MS).toISOString()
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
      .select('id, sender, amo_message_id, created_at')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const lastRow = last as { id: number; sender: string; amo_message_id: string; created_at: string } | null
    if (!lastRow || lastRow.sender !== 'bot') continue // клиент уже ответил
    if (lastRow.amo_message_id.startsWith('ga:claim:')) continue // технический маркер, не реальный ответ
    if (new Date(lastRow.created_at).getTime() > Date.now() - IDLE_NUDGE_SILENCE_MS) continue // час ещё не прошёл

    await sendStageReply(supabase, chatId, lastRow.id, IDLE_NUDGE_TEXT, 'ga:bot:idle-nudge')
  }
}

async function runOnce(): Promise<void> {
  const supabase = createAdminClient()
  await processFollowupStage(supabase)
  await processIdleNudgeStage(supabase)
}
