// Новая логика WhatsApp-бота (роли, общая память, счётчик трёх вопросов,
// согласие по смыслу, напоминания). Включается переменной
// GREENAPI_WA_ENGINE_PHONES: список номеров через запятую либо «*» — все
// клиенты. Пустая переменная — работает только прежний сценарий bot-reply.ts.
//
// CRM здесь только транспорт: решение, что ответить, принимает движок в
// сервисе smilekit-bot (/internal/wa/*, пакет smilekit_bot/wa). Память
// движка меняется по факту отправки — поэтому на каждое сообщение мы
// спрашиваем can_send перед отправкой и сообщаем delivered после.
//
// Карточки заказа и передачи менеджеру исполняет вызывающий код
// (deliverCard, см. deliverWaEngineCard в bot-reply.ts): заказ в учёте,
// группа доставки, группа «Передача от бота». Если карточка не дошла,
// движок узнаёт об этом и повторяет её по таймеру.

import type { createAdminClient } from '@/lib/supabase/admin'
import { smilekitBotFetch } from '@/lib/smilekit-bot-api'
import { sendGreenApiFileByUrl, sendGreenApiMessage, sendGreenApiVoice } from '@/lib/greenapi/client'
import { trace } from '@/lib/greenapi/trace'
import { recordEvent } from '@/lib/control-center'
import { logBotEvent } from '@/lib/bot-log'

type Supabase = ReturnType<typeof createAdminClient>

/** Движок ходит в модель дважды за реплику (понимание + ответ). */
const HANDLE_TIMEOUT_MS = 90_000
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export interface WaOutgoing {
  id: string
  chatId: string
  kind: 'text' | 'photo' | 'voice' | 'qr'
  body: string
  after: string[]
}

interface WaResponse {
  outgoing: WaOutgoing[]
  cards: WaCard[]
}

export interface WaInboundMessage {
  id: string
  kind: 'text' | 'image' | 'voice'
  text: string
  mediaUrl?: string | null
}

function digits(value: string): string {
  return value.replace(/\D/g, '')
}

function waEnginePhones(): string[] {
  return (process.env.GREENAPI_WA_ENGINE_PHONES ?? '').split(',').map(digits).filter(Boolean)
}

function isWaEngineForEveryone(): boolean {
  return (process.env.GREENAPI_WA_ENGINE_PHONES ?? '').split(',').some((value) => value.trim() === '*')
}

export function isWaEnginePhone(chatId: string): boolean {
  return isWaEngineForEveryone() || waEnginePhones().includes(digits(chatId))
}

export function isWaEngineEnabled(): boolean {
  return isWaEngineForEveryone() || waEnginePhones().length > 0
}

export type WaCard = Record<string, unknown>

export interface WaEngineDeps {
  /** Можно ли боту писать в чат: выключатель, менеджер, стоп-лист. */
  gate: (chatId: string) => Promise<boolean>
  /** Исполнить карточку (заказ или передача менеджеру). false — не дошла. */
  deliverCard: (card: WaCard) => Promise<boolean>
}

/** Что записать в историю чата вместо файла — клиент этот текст не видит. */
export function waHistoryText(out: Pick<WaOutgoing, 'kind' | 'body'>): string {
  if (out.kind === 'photo') return '[фото результата]'
  if (out.kind === 'qr') return '[QR оплаты]'
  if (out.kind === 'voice') return `[голосовое: ${out.body.split('/').pop()}]`
  return out.body
}

/** Адрес файла в сервисе бота: фото и QR раздаются из /media/results, голосовые — из /media/voice. */
export function waMediaUrl(base: string, out: Pick<WaOutgoing, 'kind' | 'body'>): string {
  const name = out.body.split('/').pop() ?? out.body
  return `${base}/media/${out.kind === 'voice' ? 'voice' : 'results'}/${name}`
}

async function downloadImage(mediaUrl: string): Promise<{ imageBase64: string; mime: string } | null> {
  try {
    const response = await fetch(mediaUrl, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null
    return { imageBase64: bytes.toString('base64'), mime: response.headers.get('content-type') ?? 'image/jpeg' }
  } catch (error) {
    console.error('wa-engine: image download failed', error)
    return null
  }
}

async function deliverCards(cards: WaCard[], deps: WaEngineDeps): Promise<void> {
  for (const card of cards) {
    const chatId = typeof card.chat_id === 'string' ? card.chat_id : ''
    const type = typeof card.type === 'string' ? card.type : ''
    let ok = false
    try {
      ok = await deps.deliverCard(card)
    } catch (error) {
      console.error('wa-engine: card delivery threw', type, error)
    }
    trace('wa-engine.card', chatId, { type, delivered: ok, card })
    if (!ok && chatId) {
      const reported = await smilekitBotFetch('/internal/wa/card_failed', { method: 'POST', body: { chatId, type } })
      if (!reported.ok) console.error('wa-engine: card_failed report failed', reported.error)
    }
  }
}

async function confirm(out: WaOutgoing, ok: boolean, uncertain = false): Promise<void> {
  const result = await smilekitBotFetch('/internal/wa/delivered', {
    method: 'POST',
    body: { chatId: out.chatId, id: out.id, ok, uncertain },
  })
  if (!result.ok) console.error('wa-engine: delivered report failed', out.id, result.error)
}

/**
 * Отправляет ответы по порядку. gate — проверка CRM (общий выключатель,
 * менеджер ведёт чат, стоп-лист); can_send — проверка движка (клиент успел
 * написать новое, чат забрал менеджер, ночь для напоминаний).
 */
/**
 * Сервис отправки ответил ошибкой 5xx. Инцидент 13.10: Green API отдавал
 * «HTTP 500 Connection to queue not established», но часть сообщений всё же
 * доставлял. Поэтому такую отправку нельзя ни повторять (клиент получит
 * дубль), ни стирать из истории (эхо запишется как сообщение оператора, и
 * бот замолчит в чате).
 */
export function isServiceError(error: unknown): boolean {
  // Таймаут — тот же случай: запрос ушёл, ответа не дождались.
  if (error instanceof Error && error.name === 'TimeoutError') return true
  return /HTTP 5\d\d/.test(error instanceof Error ? error.message : String(error))
}

export async function sendWaOutgoing(
  supabase: Supabase,
  outgoing: WaOutgoing[],
  gate: WaEngineDeps['gate'],
  opts: { stopOnServiceError?: boolean } = {}
): Promise<{ serviceError: boolean }> {
  let serviceError = false
  const mediaBase = process.env.SMILEKIT_BOT_API_URL?.replace(/\/$/, '')
  const failed = new Set<string>()
  for (const [index, out] of outgoing.entries()) {
    // Пачка напоминаний: после первой ошибки сервиса остальное не отправляем —
    // движок выдержит паузу и вернётся к этим чатам позже.
    if ((serviceError && opts.stopOnServiceError) || out.after.some((id) => failed.has(id))) {
      failed.add(out.id)
      await confirm(out, false)
      continue
    }
    const allowed = (await gate(out.chatId))
      ? await smilekitBotFetch<{ ok: boolean }>('/internal/wa/can_send', {
        method: 'POST',
        body: { chatId: out.chatId, id: out.id },
      })
      : null
    if (!allowed?.ok || !allowed.data.ok) {
      trace('wa-engine.skip', out.chatId, { id: out.id, why: 'отправка отменена: устарело или бот в этом чате сейчас молчит' })
      logBotEvent({ chatId: out.chatId, event: 'send_skipped', details: { id: out.id, kind: out.kind, reason: allowed ? 'устарело или бот молчит' : 'бот выключен или чат у менеджера' } })
      failed.add(out.id)
      await confirm(out, false)
      continue
    }

    // Запись в историю ДО отправки — как у всех исходящих бота.
    const rowId = `ga:wa:${out.id}`
    const { data: reserved, error: reserveError } = await supabase.from('chat_messages').upsert({
      amo_message_id: rowId,
      chat_id: out.chatId,
      direction: 'out',
      sender: 'bot',
      text: waHistoryText(out),
    }, { onConflict: 'amo_message_id', ignoreDuplicates: true }).select('id')
    if (reserveError || !reserved?.length) {
      // Строка уже есть — значит, это сообщение отправлял другой проход.
      if (reserveError) console.error('wa-engine: reserve failed', reserveError.message)
      failed.add(out.id)
      continue
    }

    let ok = true
    let uncertain = false
    try {
      const chatId = `${out.chatId}@c.us`
      if (out.kind === 'text') {
        await sendGreenApiMessage(chatId, out.body)
      } else {
        if (!mediaBase) throw new Error('SMILEKIT_BOT_API_URL не задан — файл отправить неоткуда')
        const url = waMediaUrl(mediaBase, out)
        const fileName = out.body.split('/').pop() ?? 'file'
        if (out.kind === 'voice') await sendGreenApiVoice(chatId, url, fileName)
        else await sendGreenApiFileByUrl({ chatId, urlFile: url, fileName })
      }
    } catch (error) {
      console.error('wa-engine: send failed', out.id, error)
      if (isServiceError(error)) {
        // Возможно, доставлено: запись в истории остаётся, повтора не будет.
        uncertain = true
        serviceError = true
      } else {
        ok = false
        failed.add(out.id)
        await supabase.from('chat_messages').delete().eq('amo_message_id', rowId)
      }
    }
    trace('wa-engine.outbound', out.chatId, { id: out.id, kind: out.kind, text: waHistoryText(out), sent: ok, uncertain })
    logBotEvent({
      chatId: out.chatId,
      event: ok ? (uncertain ? 'send_uncertain' : 'sent') : 'send_failed',
      level: ok && !uncertain ? 'info' : 'error',
      details: { id: out.id, kind: out.kind, text: waHistoryText(out) },
    })
    await confirm(out, ok, uncertain)
    if (index < outgoing.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 900 + Math.random() * 500))
    }
  }
  return { serviceError }
}

/** Сколько раз подряд движок не ответил — для сигнала в Control Center. */
const ALERT_AFTER_FAILURES = 3
const ALERT_REPEAT_MS = 10 * 60_000
let consecutiveFailures = 0
let lastAlertAt = 0

function noteEngineResult(ok: boolean, error?: string): void {
  if (ok) {
    consecutiveFailures = 0
    return
  }
  consecutiveFailures += 1
  if (consecutiveFailures >= ALERT_AFTER_FAILURES && Date.now() - lastAlertAt > ALERT_REPEAT_MS) {
    lastAlertAt = Date.now()
    recordEvent({
      type: 'error',
      level: 'error',
      title: 'WhatsApp: движок бота не отвечает',
      payload: { failuresInRow: consecutiveFailures, error: error ?? null },
    })
  }
}

const RETRY_BACKOFF_MS = [60_000, 3 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000]
/** Старше этого возраста отвечать уже поздно — оставляем менеджеру. */
const RETRY_MAX_AGE_MS = 6 * 60 * 60_000

type WaSeed = { hasHistory: boolean; orderPlaced: boolean }

/** Один вызов движка. false — движок не ответил, сообщение нужно повторить. */
async function handleInbound(
  supabase: Supabase,
  chatId: string,
  message: WaInboundMessage,
  seed: WaSeed,
  deps: WaEngineDeps
): Promise<{ ok: boolean; error?: string }> {
  const startedAt = Date.now()
  const image = message.kind === 'image' && message.mediaUrl ? await downloadImage(message.mediaUrl) : null
  const result = await smilekitBotFetch<WaResponse>('/internal/wa/handle', {
    method: 'POST',
    timeoutMs: HANDLE_TIMEOUT_MS,
    body: {
      chatId,
      seed,
      messages: [{ id: message.id, kind: message.kind, text: message.text, ...(image ?? {}) }],
    },
  })
  if (!result.ok) {
    console.error('wa-engine: handle failed', result.status, result.error)
    trace('wa-engine.error', chatId, { why: `движок не ответил: ${result.error}` })
    noteEngineResult(false, `${result.status} ${result.error}`)
    logBotEvent({ chatId, event: 'engine_failed', level: 'error', details: { messageId: message.id, status: result.status, error: result.error, ms: Date.now() - startedAt } })
    return { ok: false, error: `${result.status} ${result.error}` }
  }
  noteEngineResult(true)
  logBotEvent({ chatId, event: 'engine_ok', details: { messageId: message.id, ms: Date.now() - startedAt, replies: result.data.outgoing.length, cards: result.data.cards.length } })
  trace('wa-engine.reply', chatId, () => ({
    outgoing: result.data.outgoing.map((out) => waHistoryText(out)),
    cards: result.data.cards.length,
  }))
  // Сначала сообщения клиенту, потом карточки: передача менеджеру ставит
  // метку «бот молчит», и после неё прощальное сообщение уже не ушло бы.
  await sendWaOutgoing(supabase, result.data.outgoing, deps.gate)
  await deliverCards(result.data.cards, deps)
  return { ok: true }
}

/** Входящая реплика клиента. seed — что известно о чате из прежнего бота. */
export async function runWaEngineForInbound(
  supabase: Supabase,
  chatId: string,
  message: WaInboundMessage,
  seed: WaSeed,
  deps: WaEngineDeps
): Promise<void> {
  const result = await handleInbound(supabase, chatId, message, seed, deps)
  if (result.ok) return
  // Сообщение и сделка уже сохранены вызывающим кодом; чтобы клиент не остался
  // без ответа, ставим повтор — его сделает runWaEngineRetries, как только
  // движок снова начнёт отвечать.
  const { error } = await supabase.from('wa_engine_retries').upsert(
    {
      message_id: message.id,
      chat_id: chatId,
      kind: message.kind,
      text: message.text,
      media_url: message.mediaUrl ?? null,
      seed,
      attempts: 1,
      last_error: result.error ?? null,
      next_try_at: new Date(Date.now() + RETRY_BACKOFF_MS[0]).toISOString(),
    },
    { onConflict: 'message_id', ignoreDuplicates: true }
  )
  if (error) console.error('wa-engine: retry enqueue failed', error.message)
  logBotEvent({ chatId, event: 'retry_queued', level: 'warn', details: { messageId: message.id, error: result.error ?? null, queued: !error } })
}

interface RetryRow {
  message_id: string
  chat_id: string
  kind: WaInboundMessage['kind']
  text: string
  media_url: string | null
  seed: WaSeed
  attempts: number
  created_at: string
}

/** Повторяет сообщения, оставшиеся без ответа из-за сбоя движка. */
export async function runWaEngineRetries(supabase: Supabase, deps: WaEngineDeps): Promise<void> {
  const { data, error } = await supabase
    .from('wa_engine_retries')
    .select('message_id, chat_id, kind, text, media_url, seed, attempts, created_at')
    .is('done_at', null)
    .lte('next_try_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(10)
  if (error) {
    console.error('wa-engine: retry select failed', error.message)
    return
  }
  const markDone = (id: string, note?: string) =>
    supabase.from('wa_engine_retries').update({ done_at: new Date().toISOString(), ...(note ? { last_error: note } : {}) }).eq('message_id', id)

  for (const row of (data ?? []) as RetryRow[]) {
    if (Date.now() - new Date(row.created_at).getTime() > RETRY_MAX_AGE_MS) {
      await markDone(row.message_id, 'слишком поздно — оставлено менеджеру')
      continue
    }
    // Мог ответить менеджер или сам бот на следующее сообщение — тогда повтор лишний.
    const { data: later } = await supabase
      .from('chat_messages')
      .select('id')
      .eq('chat_id', row.chat_id)
      .eq('direction', 'out')
      .gt('created_at', row.created_at)
      .limit(1)
    if (later?.length) {
      await markDone(row.message_id, 'уже есть ответ в чате')
      continue
    }
    if (!(await deps.gate(row.chat_id))) {
      await markDone(row.message_id, 'бот в этом чате выключен или чат у менеджера')
      continue
    }
    const result = await handleInbound(
      supabase,
      row.chat_id,
      { id: row.message_id, kind: row.kind, text: row.text, mediaUrl: row.media_url },
      row.seed,
      deps
    )
    if (result.ok) {
      await markDone(row.message_id)
      logBotEvent({ chatId: row.chat_id, event: 'retry_done', details: { messageId: row.message_id, attempts: row.attempts } })
      continue
    }
    const attempts = row.attempts + 1
    if (attempts > RETRY_BACKOFF_MS.length) {
      await markDone(row.message_id, `сдались после ${attempts - 1} повторов: ${result.error}`)
      logBotEvent({ chatId: row.chat_id, event: 'retry_gave_up', level: 'error', details: { messageId: row.message_id, error: result.error } })
      recordEvent({ type: 'error', level: 'error', title: 'WhatsApp: клиент остался без ответа после повторов', payload: { messageId: row.message_id } })
      continue
    }
    await supabase
      .from('wa_engine_retries')
      .update({
        attempts,
        last_error: result.error ?? null,
        next_try_at: new Date(Date.now() + RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)]).toISOString(),
      })
      .eq('message_id', row.message_id)
  }
}

/** После ошибки сервиса отправки напоминания не трогаем столько времени. */
const TICK_PAUSE_AFTER_SERVICE_ERROR_MS = 10 * 60_000
let tickPausedUntil = 0

/** Раз в минуту из планировщика: напоминания при молчании и повтор передачи. */
export async function runWaEngineTick(supabase: Supabase, deps: WaEngineDeps): Promise<void> {
  if (!isWaEngineEnabled()) return
  if (Date.now() < tickPausedUntil) return
  const result = await smilekitBotFetch<WaResponse>('/internal/wa/tick', { method: 'POST', body: {}, timeoutMs: 30_000 })
  if (!result.ok) {
    console.error('wa-engine: tick failed', result.status, result.error)
    noteEngineResult(false, `tick ${result.status} ${result.error}`)
    return
  }
  noteEngineResult(true)
  // Движок помнит все чаты, которые когда-либо вёл; работаем только с включёнными.
  const mine = (chatId: unknown) => typeof chatId === 'string' && isWaEnginePhone(chatId)
  const { serviceError } = await sendWaOutgoing(
    supabase,
    result.data.outgoing.filter((out) => mine(out.chatId)),
    deps.gate,
    { stopOnServiceError: true }
  )
  if (serviceError) {
    tickPausedUntil = Date.now() + TICK_PAUSE_AFTER_SERVICE_ERROR_MS
    console.error('wa-engine: сервис отправки отвечает ошибкой — напоминания приостановлены на 10 минут')
  }
  await deliverCards(result.data.cards.filter((card) => mine(card.chat_id)), deps)
  // Движок жив (tick ответил) — самое время дослать то, что не обработалось в сбой.
  await runWaEngineRetries(supabase, deps)
}
