// Два дожима после блока результата, если клиент молчит:
// 1. Через 5 минут — вопрос «вам оформить?» (FOLLOWUP_ANCHOR_TEXT).
// 2. Через 24 часа после ЭТОГО вопроса, если клиент так и не ответил, —
//    напоминание (see bot-reply.ts: NUDGE_24H_TEXT).
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
  NUDGE_24H_TEXT,
  ORDER_CTA_FOLLOWUP_TEXT,
} from '@/lib/greenapi/bot-reply'

const TICK_INTERVAL_MS = 60_000
const FOLLOWUP_SILENCE_MS = 5 * 60_000
const NUDGE_SILENCE_MS = 24 * 3600_000

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

/**
 * Общий шаг для обеих стадий: анкер (последняя запись в чате с заданным
 * текстом и старше порога) -> отправить replyText. Якорь ещё актуален,
 * только если это ПОСЛЕДНЯЯ запись в чате — любое следующее сообщение
 * (ответ клиента или уже отправленный шаг) снимает триггер естественным
 * образом, без отдельного флага «отправлено».
 */
async function processStage(
  supabase: ReturnType<typeof createAdminClient>,
  anchorText: string,
  silenceMs: number,
  replyText: string,
  messageIdPrefix: string
): Promise<void> {
  const cutoff = new Date(Date.now() - silenceMs).toISOString()
  const { data: anchors } = await supabase
    .from('amocrm_messages')
    .select('id, chat_id')
    .eq('sender', 'bot')
    .eq('text', anchorText)
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

    if (!(await canSendGreenApiBotReply(supabase, anchor.chat_id))) continue

    const botMessageId = `${messageIdPrefix}:${anchor.id}`
    const { error: reserveError } = await supabase.from('amocrm_messages').upsert({
      amo_message_id: botMessageId,
      chat_id: anchor.chat_id,
      direction: 'out',
      sender: 'bot',
      text: replyText,
    }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
    if (reserveError) {
      console.error('greenapi followup scheduler: reserve failed', reserveError.message)
      continue
    }
    try {
      await sendGreenApiMessage(`${anchor.chat_id}@c.us`, replyText)
    } catch (error) {
      await supabase.from('amocrm_messages').delete().eq('amo_message_id', botMessageId)
      console.error('greenapi followup scheduler: send failed', error)
    }
  }
}

async function runOnce(): Promise<void> {
  const supabase = createAdminClient()
  await processStage(supabase, FOLLOWUP_ANCHOR_TEXT, FOLLOWUP_SILENCE_MS, ORDER_CTA_FOLLOWUP_TEXT, 'ga:bot:followup')
  await processStage(supabase, ORDER_CTA_FOLLOWUP_TEXT, NUDGE_SILENCE_MS, NUDGE_24H_TEXT, 'ga:bot:nudge24h')
}
