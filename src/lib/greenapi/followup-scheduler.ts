// Дожим клиента, если он молчит:
// -1. Если клиент 5 минут не назвал город —
//    followup-scheduler.ts сам шлёт блок «до/после» (sendResultsPhotoOnly),
//    без доставки и голосового (город ещё не известен). См.
//    CITY_WAIT_ANCHOR_ID_PREFIX ниже.
// 1. Через 30 минут после ЛЮБОГО последнего ответа бота (на любом этапе
//    диалога, в т.ч. после CTA) — обычный дожим, вариант ротируется (see
//    bot-reply.ts: IDLE_NUDGE_VARIANTS/nextIdleNudgeReply), не повторяет
//    один и тот же текст при разных периодах молчания в одном чате.
// 2. Если клиент так и не ответил ещё 24 часа ПОСЛЕ этого дожима — вторая
//    волна сразу предлагает скидку по лестнице (13%→20%), не повторяет
//    первый дожим.
// Если последним бот предложил скидку 13% (по любому поводу — прямая
// просьба, отказ на CTA) и клиент молчит 30 минут — дожим сразу эскалирует
// до 20%, не дожидаясь второй волны.
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
  CITY_WAIT_ANCHOR_ID_PREFIX,
  IDLE_NUDGE_ID_PREFIX,
  nextIdleNudgeReply,
  POST_RESULTS_STAGE_ANCHOR_ID_PREFIX,
  PROMISED_ANCHOR_ID_PREFIX,
  sendResultsPhotoOnly,
} from '@/lib/greenapi/bot-reply'
import { trace } from '@/lib/greenapi/trace'

/**
 * Настройки одного прогона проверки дожимов. Нужны только отладчику
 * (scripts/bot-cli-server.mts): боевой планировщик зовёт runOnce() без
 * аргументов и работает ровно как раньше.
 *
 * onlyChatId — смотреть только этот чат (служебный чат отладчика, у него
 * нетелефонный id, и боевой фильтр isRealPhoneChatId его отбрасывает).
 * dryRun — ничего не отправлять в Green API, только показать, что ушло бы.
 */
export interface FollowupRunOptions {
  onlyChatId?: string
  dryRun?: boolean
  /**
   * Прогнать и те этапы, что в проде выключены флагом (сейчас — дожим при
   * молчании). Только для наблюдения в отладчике: «а что было бы, если бы
   * дожим включили». Боевой планировщик это не использует.
   */
  includeDisabledStages?: boolean
}

// Живой баг: «Лаборатория» (dryRun) пишет тестовые сообщения в ту же
// chat_messages, что и реальные чаты (chat_id вида `lab-...`), и
// планировщик пытался слать им реальные дожимы через Green API — падало на
// каждом тике с HTTP 400 (chatId не в формате телефона). Настоящий chat_id
// Green API — всегда только цифры (см. phoneFromGreenApiChatId).
const isRealPhoneChatId = (chatId: string, opts: FollowupRunOptions = {}): boolean =>
  opts.onlyChatId ? chatId === opts.onlyChatId : /^\d+$/.test(chatId)

const TICK_INTERVAL_MS = 60_000
const NUDGE_SILENCE_MS = 30 * 60_000
const SECOND_WAVE_SILENCE_MS = 24 * 3600_000
// Тот же порог, что раньше был у CTA со скидкой, но для CITY_QUESTION.
const CITY_WAIT_SILENCE_MS = 5 * 60_000
const CITY_WAIT_MAX_AGE_MS = 24 * 3600_000

let started = false
// Живой баг: без этого флага тик, который не успел уложиться в TICK_INTERVAL_MS
// (до 200 чатов последовательных await на БД + Green API), пересекался со
// следующим — оба находили один и тот же устаревший чат почти одновременно
// и оба слали сообщение до того, как первый успевал зарезервировать строку
// в БД. .select() в sendStageReply исключает дубль уже после гонки, а этот
// флаг убирает саму гонку.
let running = false

export function startFollowupScheduler(): void {
  if (started) return
  started = true
  console.log('greenapi followup scheduler started')
  const tick = () => {
    if (running) return
    running = true
    void runOnce()
      .catch((error) => console.error('greenapi followup scheduler failed', error))
      .finally(() => { running = false })
  }
  tick()
  setInterval(tick, TICK_INTERVAL_MS).unref?.()
}

async function sendStageReply(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string,
  lastId: number,
  replyText: string,
  messageIdPrefix: string,
  opts: FollowupRunOptions = {}
): Promise<void> {
  if (!(await canSendGreenApiBotReply(supabase, chatId, { dryRun: opts.dryRun }))) return

  const botMessageId = `${messageIdPrefix}:${lastId}`
  // Живой баг: upsert с ignoreDuplicates молча не вставляет строку при
  // повторе, но отправка ниже шла безусловно — если два тика планировщика
  // (не защищённых от наложения, см. startFollowupScheduler) находили один
  // и тот же устаревший чат, оба слали сообщение клиенту дважды, хотя в БД
  // оставалась одна строка. .select() — тот же приём, что claimOnce/
  // claimResultsBlock в bot-reply.ts: без вставленной строки не отправляем.
  const { data: reserved, error: reserveError } = await supabase.from('chat_messages').upsert({
    amo_message_id: botMessageId,
    chat_id: chatId,
    direction: 'out',
    sender: 'bot',
    text: replyText,
  }, { onConflict: 'amo_message_id', ignoreDuplicates: true }).select('id')
  if (reserveError) {
    console.error('greenapi followup scheduler: reserve failed', reserveError.message)
    return
  }
  if (!reserved?.length) return // уже отправлено другим тиком
  trace('followup.send', chatId, { text: replyText, messageId: botMessageId, sent: !opts.dryRun })
  if (opts.dryRun) return
  try {
    await sendGreenApiMessage(`${chatId}@c.us`, replyText)
  } catch (error) {
    await supabase.from('chat_messages').delete().eq('amo_message_id', botMessageId)
    console.error('greenapi followup scheduler: send failed', error)
  }
}

/**
 * Клиент сам сказал, когда вернётся («завтра», «через час» — см.
 * promisedDelayHours в bot-reply.ts). Живой пример: клиент написал «Эртен
 * киге» (кырг. «завтра»), бот вежливо согласился, а через 35 минут всё
 * равно написал «Возвращаясь к нашему разговору...» — обычный дожим не
 * знал об этом обещании. true — если срок ещё не наступил, дожим пропускаем.
 */
async function isPromisedLaterStillPending(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('chat_messages')
    .select('text')
    .eq('amo_message_id', `${PROMISED_ANCHOR_ID_PREFIX}:${chatId}`)
    .maybeSingle()
  const text = (data as { text: string } | null)?.text
  const match = text?.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)
  if (!match) return false
  return new Date(match[1]).getTime() > Date.now()
}

/**
 * Клиент молчит после последнего реального ответа бота, на любом этапе
 * диалога. Служебные маркеры (ga:claim:*, в т.ч. якорь follow-up) в счёт не
 * идут — это не реальный ответ клиенту, а внутренняя защёлка. Порог зависит
 * от того, было ли последнее сообщение уже дожимом (24 часа) или обычным
 * ответом (30 минут).
 */
async function processIdleNudgeStage(
  supabase: ReturnType<typeof createAdminClient>,
  opts: FollowupRunOptions = {}
): Promise<void> {
  const cutoff = new Date(Date.now() - NUDGE_SILENCE_MS).toISOString()
  // Живой баг: без верхней границы и с ascending этот запрос по мере роста
  // истории всё чаще упирается в лимит 200 записями из давно завершённых
  // чатов (клиент там уже ответил, lastRow.sender !== 'bot' — они просто
  // пропускаются циклом ниже), и до чатов, которые стали неактивны только
  // что, тик может вообще не доходить. descending отдаёт приоритет самым
  // свежим кандидатам — тем, кому дожим нужнее всего прямо сейчас.
  // Отладчик смотрит один служебный чат — сужаем выборку прямо в запросе,
  // иначе его чат может просто не попасть в лимит 200 боевых кандидатов.
  let candidatesQuery = supabase
    .from('chat_messages')
    .select('chat_id')
    .eq('sender', 'bot')
    .not('amo_message_id', 'like', 'ga:claim:%')
    .lte('created_at', cutoff)
  if (opts.onlyChatId) candidatesQuery = candidatesQuery.eq('chat_id', opts.onlyChatId)
  const { data: candidates } = await candidatesQuery
    .order('created_at', { ascending: false })
    .limit(200)
  if (!candidates?.length) return

  const chatIds = [...new Set((candidates as { chat_id: string }[]).map((row) => row.chat_id))]
    .filter((chatId) => isRealPhoneChatId(chatId, opts))
  for (const chatId of chatIds) {
    const { data: last } = await supabase
      .from('chat_messages')
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
    trace('followup.candidate', chatId, { stage: 'дожим при молчании', lastBotText: lastRow.text, lastBotAt: lastRow.created_at })

    // Чат ждёт первого ответа клиента после блока результата (бот сам
    // больше ничего не пишет, см. bot-reply.ts isAwaitingPostResultsReply) —
    // обычный дожим тут неуместен, иначе бот всё равно напишет клиенту
    // первым вопреки прямому запрету.
    const { data: postResultsAnchor } = await supabase
      .from('chat_messages')
      .select('id')
      .eq('amo_message_id', `${POST_RESULTS_STAGE_ANCHOR_ID_PREFIX}:${chatId}`)
      .maybeSingle()
    if (postResultsAnchor) {
      trace('followup.skip', chatId, { why: 'чат ждёт первого ответа после блока результата — бот писать первым не должен' })
      continue
    }

    const alreadyNudged = lastRow.amo_message_id.startsWith(IDLE_NUDGE_ID_PREFIX)
    const requiredSilenceMs = alreadyNudged ? SECOND_WAVE_SILENCE_MS : NUDGE_SILENCE_MS
    if (new Date(lastRow.created_at).getTime() > Date.now() - requiredSilenceMs) {
      trace('followup.skip', chatId, {
        why: `молчание короче порога (${Math.round(requiredSilenceMs / 60_000)} мин) — дожим ещё рано`,
      })
      continue
    }
    if (await isPromisedLaterStillPending(supabase, chatId)) {
      trace('followup.skip', chatId, { why: 'клиент сам обещал вернуться позже — не дёргаем' })
      continue
    }

    const replyText = await nextIdleNudgeReply(supabase, chatId, lastRow.text, lastRow.amo_message_id)
    if (!replyText) {
      trace('followup.skip', chatId, { why: 'предложить больше нечего — молчим' })
      continue
    }
    await sendStageReply(supabase, chatId, lastRow.id, replyText, IDLE_NUDGE_ID_PREFIX, opts)
  }
}

/**
 * Клиент не назвал город 5 минут после CITY_QUESTION. Ищем якоря
 * (ga:claim:city-wait:*) старше 5 минут и моложе суток; если якорь всё ещё
 * последняя запись чата — присылаем блок «до/после» (sendResultsPhotoOnly,
 * без доставки/голосового — город ещё не известен). Если клиент потом всё
 * же назовёт город, обычный путь в bot-reply.ts дошлёт доставку и
 * голосовое отдельно (см. deliveryVoiceAllowed).
 */
async function processCityWaitStage(
  supabase: ReturnType<typeof createAdminClient>,
  opts: FollowupRunOptions = {}
): Promise<void> {
  const now = Date.now()
  let anchorsQuery = supabase
    .from('chat_messages')
    .select('id, chat_id')
    .like('amo_message_id', `${CITY_WAIT_ANCHOR_ID_PREFIX}:%`)
    .gte('created_at', new Date(now - CITY_WAIT_MAX_AGE_MS).toISOString())
    .lte('created_at', new Date(now - CITY_WAIT_SILENCE_MS).toISOString())
  // См. выше: отладчику нужен именно его чат, а не первые 200 боевых.
  if (opts.onlyChatId) anchorsQuery = anchorsQuery.eq('chat_id', opts.onlyChatId)
  const { data: anchors } = await anchorsQuery
    .order('created_at', { ascending: true })
    .limit(200)
  if (!anchors?.length) return

  for (const anchor of anchors as { id: number; chat_id: string }[]) {
    if (!isRealPhoneChatId(anchor.chat_id, opts)) continue
    trace('followup.candidate', anchor.chat_id, { stage: 'клиент не назвал город', anchorId: anchor.id })
    const { data: last } = await supabase
      .from('chat_messages')
      .select('id')
      .eq('chat_id', anchor.chat_id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
    if ((last as { id: number } | null)?.id !== anchor.id) {
      trace('followup.skip', anchor.chat_id, { why: 'клиент уже ответил или бот писал после якоря' })
      continue
    }
    if (!(await canSendGreenApiBotReply(supabase, anchor.chat_id, { dryRun: opts.dryRun }))) continue
    trace('followup.send', anchor.chat_id, { text: '[блок до/после без доставки и голосового]', sent: !opts.dryRun })
    await sendResultsPhotoOnly(supabase, anchor.chat_id, { dryRun: opts.dryRun })
  }
}

// Решение владельца 2026-09-08: автоматический дожим при молчании клиента
// (30 мин → «возвращаясь к разговору», 24 ч → лестница скидок) выключен —
// бот не должен писать клиенту первым после своего ответа. Вместо дожима
// молчащий чат передаётся менеджеру (см. handOffToManager в bot-reply.ts).
// Флаг, а не удаление кода: чтобы откат был в одну строку.
const IDLE_NUDGES_ENABLED = false

async function runOnce(opts: FollowupRunOptions = {}): Promise<void> {
  const supabase = createAdminClient()
  await processCityWaitStage(supabase, opts)
  if (IDLE_NUDGES_ENABLED) await processIdleNudgeStage(supabase, opts)
  else if (opts.includeDisabledStages) {
    trace('followup.disabled', opts.onlyChatId ?? null, {
      why: 'в проде дожим при молчании выключен (IDLE_NUDGES_ENABLED = false) — ниже только показ, что было бы',
    })
    await processIdleNudgeStage(supabase, opts)
  } else {
    trace('followup.skip', opts.onlyChatId ?? null, { why: 'дожим при молчании выключен флагом IDLE_NUDGES_ENABLED' })
  }
}

/**
 * Один прогон проверки дожимов «руками» — для отладчика, который вызывает
 * нужные функции напрямую и фоновый планировщик не поднимает.
 */
export function runFollowupOnce(opts: FollowupRunOptions = {}): Promise<void> {
  return runOnce(opts)
}
