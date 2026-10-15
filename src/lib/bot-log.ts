// Журнал событий бота: приём сообщения, вызов движка, отправка, повторы,
// восстановление. Только сервер (service role). Хранится 3 суток — см.
// purgeOldBotEvents, её вызывает followup-scheduler раз в час.
//
// Запись — fire-and-forget: журнал никогда не должен ни задерживать, ни
// ломать ответ клиенту. Чтобы не нагружать память и базу, тексты режутся,
// а очередь на запись ограничена: при заторе лишние info-события отбрасываются.

import { createAdminClient } from '@/lib/supabase/admin'

export type BotLogLevel = 'info' | 'warn' | 'error'

export interface BotLogEntry {
  channel?: 'whatsapp' | 'instagram' | 'system'
  chatId?: string | null
  event: string
  level?: BotLogLevel
  details?: Record<string, unknown>
}

export const BOT_LOG_RETENTION_DAYS = 3
const MAX_TEXT = 300
const MAX_QUEUE = 200

const queue: Record<string, unknown>[] = []
let flushing = false

function clip(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value
  return value
}

export function logBotEvent(entry: BotLogEntry): void {
  const level = entry.level ?? 'info'
  // При заторе держим только проблемы — обычные события не стоят памяти.
  if (queue.length >= MAX_QUEUE && level === 'info') return
  const details: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry.details ?? {})) details[key] = clip(value)
  queue.push({
    channel: entry.channel ?? 'whatsapp',
    chat_id: entry.chatId ?? null,
    event: entry.event,
    level,
    details,
  })
  void flush()
}

async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return
  flushing = true
  try {
    const batch = queue.splice(0, 50)
    const { error } = await createAdminClient().from('bot_event_log').insert(batch)
    if (error) console.warn('bot-log: запись не удалась', error.message)
  } catch (error) {
    console.warn('bot-log: запись не удалась', error)
  } finally {
    flushing = false
    if (queue.length > 0) void flush()
  }
}

/** Удаляет записи старше срока хранения. Возвращает, получилось ли. */
export async function purgeOldBotEvents(): Promise<boolean> {
  const cutoff = new Date(Date.now() - BOT_LOG_RETENTION_DAYS * 86_400_000).toISOString()
  const { error } = await createAdminClient().from('bot_event_log').delete().lt('created_at', cutoff)
  if (error) console.warn('bot-log: очистка не удалась', error.message)
  return !error
}
