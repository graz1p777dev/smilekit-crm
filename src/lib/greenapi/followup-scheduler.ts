// Дожим клиента, если он молчит — три шага, как в обычной рассылке:
// 0. CTA «вам оформить со скидкой?» через 5 минут молчания ПОСЛЕ блока
//    результата (доставка → фото → голосовое). В конце блока bot-reply.ts
//    пишет в историю служебный якорь FOLLOWUP_ANCHOR_TEXT; если он так и
//    остался последней записью чата — шлём этот CTA (реальная скидка 13%
//    по той же лестнице nextDiscountOffer, а не просто вопрос про доставку —
//    раз уж CTA сам упоминает скидку, скидку нужно реально дать). Ответил
//    клиент — якорь сдвинут, CTA не уходит.
// -1. Аналогично для CITY_QUESTION: если клиент 5 минут не назвал город —
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
  FOLLOWUP_ANCHOR_ID_PREFIX,
  FOLLOWUP_CTA_ID_PREFIX,
  IDLE_NUDGE_ID_PREFIX,
  nextDiscountOffer,
  nextIdleNudgeReply,
  sendResultsPhotoOnly,
} from '@/lib/greenapi/bot-reply'

// Живой баг: «Лаборатория» (dryRun) пишет тестовые сообщения в ту же
// amocrm_messages, что и реальные чаты (chat_id вида `lab-...`), и
// планировщик пытался слать им реальные дожимы через Green API — падало на
// каждом тике с HTTP 400 (chatId не в формате телефона). Настоящий chat_id
// Green API — всегда только цифры (см. phoneFromGreenApiChatId).
const isRealPhoneChatId = (chatId: string): boolean => /^\d+$/.test(chatId)

const TICK_INTERVAL_MS = 60_000
const FOLLOWUP_CTA_SILENCE_MS = 5 * 60_000
// Якорь старше суток не обрабатываем: это «хвост» от чатов, где отправка
// была невозможна (менеджер в чате, бот выключен) — CTA спустя сутки после
// голосового уже не к месту.
const FOLLOWUP_CTA_MAX_AGE_MS = 24 * 3600_000
const NUDGE_SILENCE_MS = 30 * 60_000
const SECOND_WAVE_SILENCE_MS = 24 * 3600_000
// Тот же порог, что FOLLOWUP_CTA_SILENCE_MS, но для CITY_QUESTION.
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
  messageIdPrefix: string
): Promise<void> {
  if (!(await canSendGreenApiBotReply(supabase, chatId))) return

  const botMessageId = `${messageIdPrefix}:${lastId}`
  // Живой баг: upsert с ignoreDuplicates молча не вставляет строку при
  // повторе, но отправка ниже шла безусловно — если два тика планировщика
  // (не защищённых от наложения, см. startFollowupScheduler) находили один
  // и тот же устаревший чат, оба слали сообщение клиенту дважды, хотя в БД
  // оставалась одна строка. .select() — тот же приём, что claimOnce/
  // claimResultsBlock в bot-reply.ts: без вставленной строки не отправляем.
  const { data: reserved, error: reserveError } = await supabase.from('amocrm_messages').upsert({
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
  try {
    await sendGreenApiMessage(`${chatId}@c.us`, replyText)
  } catch (error) {
    await supabase.from('amocrm_messages').delete().eq('amo_message_id', botMessageId)
    console.error('greenapi followup scheduler: send failed', error)
  }
}

/**
 * Клиент молчит после последнего реального ответа бота, на любом этапе
 * диалога. Служебные маркеры (ga:claim:*, в т.ч. якорь follow-up) в счёт не
 * идут — это не реальный ответ клиенту, а внутренняя защёлка. Порог зависит
 * от того, было ли последнее сообщение уже дожимом (24 часа) или обычным
 * ответом (30 минут).
 */
async function processIdleNudgeStage(supabase: ReturnType<typeof createAdminClient>): Promise<void> {
  const cutoff = new Date(Date.now() - NUDGE_SILENCE_MS).toISOString()
  // Живой баг: без верхней границы и с ascending этот запрос по мере роста
  // истории всё чаще упирается в лимит 200 записями из давно завершённых
  // чатов (клиент там уже ответил, lastRow.sender !== 'bot' — они просто
  // пропускаются циклом ниже), и до чатов, которые стали неактивны только
  // что, тик может вообще не доходить. descending отдаёт приоритет самым
  // свежим кандидатам — тем, кому дожим нужнее всего прямо сейчас.
  const { data: candidates } = await supabase
    .from('amocrm_messages')
    .select('chat_id')
    .eq('sender', 'bot')
    .not('amo_message_id', 'like', 'ga:claim:%')
    .lte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(200)
  if (!candidates?.length) return

  const chatIds = [...new Set((candidates as { chat_id: string }[]).map((row) => row.chat_id))]
    .filter(isRealPhoneChatId)
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

/**
 * Шаг 0: CTA через 5 минут после блока результата. Ищем якоря
 * (ga:claim:followup:*) старше 5 минут и моложе суток; CTA уходит, только
 * если якорь всё ещё последняя запись чата — то есть ни клиент, ни бот с
 * тех пор ничего не писали. Повтор исключён: id CTA привязан к id якоря, а
 * после отправки последней записью становится сам CTA. Текст CTA — реальное
 * предложение скидки 13% (nextDiscountOffer), а не просто вопрос про
 * доставку: раз клиент увидит «со скидкой», скидка должна быть настоящей,
 * а не только словами. Если клиент откажет и на неё — та же лестница,
 * что и на прямую просьбу о скидке (см. NEGATIVE_ONLY в bot-reply.ts).
 */
async function processFollowupCtaStage(supabase: ReturnType<typeof createAdminClient>): Promise<void> {
  const now = Date.now()
  const { data: anchors } = await supabase
    .from('amocrm_messages')
    .select('id, chat_id')
    .like('amo_message_id', `${FOLLOWUP_ANCHOR_ID_PREFIX}:%`)
    .gte('created_at', new Date(now - FOLLOWUP_CTA_MAX_AGE_MS).toISOString())
    .lte('created_at', new Date(now - FOLLOWUP_CTA_SILENCE_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(200)
  if (!anchors?.length) return

  for (const anchor of anchors as { id: number; chat_id: string }[]) {
    if (!isRealPhoneChatId(anchor.chat_id)) continue
    const { data: last } = await supabase
      .from('amocrm_messages')
      .select('id')
      .eq('chat_id', anchor.chat_id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
    if ((last as { id: number } | null)?.id !== anchor.id) continue // клиент ответил или бот уже писал
    const discountCta = await nextDiscountOffer(supabase, anchor.chat_id)
    await sendStageReply(supabase, anchor.chat_id, anchor.id, discountCta, FOLLOWUP_CTA_ID_PREFIX)
  }
}

/**
 * Шаг -1: клиент не назвал город 5 минут после CITY_QUESTION. Ищем якоря
 * (ga:claim:city-wait:*) старше 5 минут и моложе суток; если якорь всё ещё
 * последняя запись чата — присылаем блок «до/после» (sendResultsPhotoOnly,
 * без доставки/голосового — город ещё не известен). Если клиент потом всё
 * же назовёт город, обычный путь в bot-reply.ts дошлёт доставку и
 * голосовое отдельно (см. deliveryVoiceAllowed).
 */
async function processCityWaitStage(supabase: ReturnType<typeof createAdminClient>): Promise<void> {
  const now = Date.now()
  const { data: anchors } = await supabase
    .from('amocrm_messages')
    .select('id, chat_id')
    .like('amo_message_id', `${CITY_WAIT_ANCHOR_ID_PREFIX}:%`)
    .gte('created_at', new Date(now - CITY_WAIT_MAX_AGE_MS).toISOString())
    .lte('created_at', new Date(now - CITY_WAIT_SILENCE_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(200)
  if (!anchors?.length) return

  for (const anchor of anchors as { id: number; chat_id: string }[]) {
    if (!isRealPhoneChatId(anchor.chat_id)) continue
    const { data: last } = await supabase
      .from('amocrm_messages')
      .select('id')
      .eq('chat_id', anchor.chat_id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
    if ((last as { id: number } | null)?.id !== anchor.id) continue // клиент ответил или бот уже писал
    if (!(await canSendGreenApiBotReply(supabase, anchor.chat_id))) continue
    await sendResultsPhotoOnly(supabase, anchor.chat_id)
  }
}

async function runOnce(): Promise<void> {
  const supabase = createAdminClient()
  await processCityWaitStage(supabase)
  await processFollowupCtaStage(supabase)
  await processIdleNudgeStage(supabase)
}
