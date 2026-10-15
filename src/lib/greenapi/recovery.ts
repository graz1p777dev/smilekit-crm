// Восстановление после сбоя бота: находит чаты, где последнее слово за
// клиентом (ни бот, ни менеджер не ответили), и просит движок ответить на
// их вопросы. Запускается кнопкой в CRM (Настройки → WhatsApp → Здоровье бота).
//
// Только сервер. Тексты автоматов (якоря «[ожидание города]» и т.п.) в
// расчёт «ответили» не входят — это служебные строки, клиент их не видит.

import { createAdminClient } from '@/lib/supabase/admin'
import { logBotEvent } from '@/lib/bot-log'
import { isWaEnginePhone } from '@/lib/greenapi/wa-engine'
import { recoverWaChat, waEngineGate } from '@/lib/greenapi/bot-reply'

type Supabase = ReturnType<typeof createAdminClient>

export interface UnansweredChat {
  chatId: string
  lastAt: string
  ageMin: number
  messages: number
  preview: string
  /** id последнего входящего — основа идемпотентности восстановления. */
  lastInId: number
  text: string
  mediaUrl: string | null
  botCanReply: boolean
}

interface Row {
  id: number
  chat_id: string
  direction: string
  text: string | null
  created_at: string
}

const MEDIA_MARKER = '[media]'

/** Окно поиска: старше этого клиенту уже поздно отвечать «из сбоя». */
export const RECOVERY_WINDOW_HOURS = 24

export async function findUnansweredChats(
  supabase: Supabase,
  opts: { hours?: number; minAgeMin?: number; withGate?: boolean } = {}
): Promise<UnansweredChat[]> {
  const hours = opts.hours ?? RECOVERY_WINDOW_HOURS
  const minAgeMs = (opts.minAgeMin ?? 3) * 60_000
  const since = new Date(Date.now() - hours * 3600_000).toISOString()
  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, chat_id, direction, text, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(6000)
  if (error) throw new Error(error.message)

  const byChat = new Map<string, Row[]>()
  for (const row of (data ?? []) as Row[]) {
    if (!/^\d+$/.test(row.chat_id) || !isWaEnginePhone(row.chat_id)) continue
    // Служебные якоря бота (direction=out, текст в квадратных скобках) — не ответ.
    if (row.direction === 'out' && (row.text ?? '').startsWith('[')) continue
    const list = byChat.get(row.chat_id) ?? []
    list.push(row)
    byChat.set(row.chat_id, list)
  }

  const result: UnansweredChat[] = []
  for (const [chatId, rows] of byChat) {
    let lastOut = -1
    rows.forEach((row, index) => {
      if (row.direction === 'out') lastOut = index
    })
    const trailing = rows.slice(lastOut + 1).filter((row) => row.direction === 'in')
    if (!trailing.length) continue
    const last = trailing[trailing.length - 1]
    const age = Date.now() - new Date(last.created_at).getTime()
    if (age < minAgeMs) continue
    const mediaUrls = trailing
      .map((row) => (row.text ?? '').split(MEDIA_MARKER)[1]?.trim())
      .filter((url): url is string => Boolean(url))
    const text = trailing
      .map((row) => (row.text ?? '').split(MEDIA_MARKER)[0].trim())
      .filter(Boolean)
      .join('\n')
    result.push({
      chatId,
      lastAt: last.created_at,
      ageMin: Math.round(age / 60_000),
      messages: trailing.length,
      preview: (text || (mediaUrls.length ? '[вложение]' : '')).slice(0, 120),
      lastInId: last.id,
      text,
      mediaUrl: mediaUrls[mediaUrls.length - 1] ?? null,
      botCanReply: true,
    })
  }
  result.sort((a, b) => a.lastAt.localeCompare(b.lastAt))

  if (opts.withGate) {
    const queue = result.slice(0, 100)
    for (let i = 0; i < queue.length; i += 5) {
      await Promise.all(
        queue.slice(i, i + 5).map(async (chat) => {
          chat.botCanReply = await waEngineGate(supabase, chat.chatId).catch(() => false)
        })
      )
    }
  }
  return result
}

export interface RecoveryState {
  running: boolean
  startedAt: string | null
  total: number
  done: number
  replied: number
  skipped: number
}

const state: RecoveryState = { running: false, startedAt: null, total: 0, done: 0, replied: 0, skipped: 0 }

export function getRecoveryState(): RecoveryState {
  return { ...state }
}

const PAUSE_BETWEEN_CHATS_MS = 3_000
const MAX_CHATS_PER_RUN = 100

/**
 * Запускает восстановление в фоне и сразу возвращается. Один запуск за раз.
 * Ответы клиентам пишет сам движок; чаты, где бот выключен или ведёт
 * менеджер, пропускаются.
 */
export function startRecovery(chats: UnansweredChat[]): { started: boolean; total: number } {
  if (state.running) return { started: false, total: state.total }
  const queue = chats.filter((chat) => chat.botCanReply).slice(0, MAX_CHATS_PER_RUN)
  Object.assign(state, { running: true, startedAt: new Date().toISOString(), total: queue.length, done: 0, replied: 0, skipped: 0 })
  logBotEvent({ channel: 'system', event: 'recovery_started', level: 'warn', details: { chats: queue.length } })
  void (async () => {
    const supabase = createAdminClient()
    for (const chat of queue) {
      try {
        const sent = await recoverWaChat(chat.chatId, {
          id: `recovery:${chat.lastInId}`,
          text: chat.text,
          mediaUrl: chat.mediaUrl,
        })
        if (sent) {
          state.replied += 1
          // Повтор из очереди по этому чату больше не нужен.
          await supabase.from('wa_engine_retries').update({ done_at: new Date().toISOString(), last_error: 'восстановлено вручную' }).eq('chat_id', chat.chatId).is('done_at', null)
        } else {
          state.skipped += 1
        }
        logBotEvent({ chatId: chat.chatId, event: 'recovery_chat', details: { handled: sent, waitedMin: chat.ageMin } })
      } catch (error) {
        state.skipped += 1
        logBotEvent({ chatId: chat.chatId, event: 'recovery_chat', level: 'error', details: { error: error instanceof Error ? error.message : String(error) } })
      }
      state.done += 1
      await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_CHATS_MS))
    }
    state.running = false
    logBotEvent({ channel: 'system', event: 'recovery_finished', details: { replied: state.replied, skipped: state.skipped } })
  })()
  return { started: true, total: queue.length }
}
