// Напоминание сотруднику на смене: клиент написал 15 минут назад, и ему
// никто не ответил — ни человек, ни бот. Уходит в Telegram (/staffs), один
// раз на сообщение клиента (staff_reply_reminders).
//
// Что считается ответом — то же правило, что в аналитике: сообщение
// человека (кроме пометки массовой рассылки) или настоящий ответ бота
// (не служебный якорь ga:claim:* и не рассылка campaign:*).

import { createAdminClient } from '@/lib/supabase/admin'
import { BULK_BROADCAST_AUTHOR_MARKER } from '@/lib/greenapi/bot-reply'
import { REPLY_REMINDER_AFTER_MS } from './rules'
import { notifyTelegram } from './notify'
import { openShifts } from './service'
import { staffPhones } from './phones'

const POLL_INTERVAL_MS = 60_000
/** Старше этого не напоминаем: после паузы сервера не засыпать сотрудника старьём. */
const LOOKBACK_MS = 3 * 3600_000
/** Сколько клиентов перечислить в одном сообщении. */
const MAX_LISTED = 10

interface MessageRow {
  id: number
  chat_id: string
  sender: string
  author_name: string | null
  amo_message_id: string | null
  text: string | null
  created_at: string
}

export function isReply(row: Pick<MessageRow, 'sender' | 'author_name' | 'amo_message_id'>): boolean {
  if (row.sender === 'operator') return row.author_name !== BULK_BROADCAST_AUTHOR_MARKER
  if (row.sender === 'bot') {
    const id = row.amo_message_id ?? ''
    return !id.startsWith('ga:claim:') && !id.startsWith('campaign:')
  }
  return false
}

/**
 * Чаты, где последнее сообщение клиента осталось без ответа. Берём самое
 * свежее сообщение клиента в чате: если после него был ответ — чат не ждёт.
 */
export function waitingChats(rows: MessageRow[]): MessageRow[] {
  const byChat = new Map<string, MessageRow[]>()
  for (const row of rows) {
    const list = byChat.get(row.chat_id) ?? []
    list.push(row)
    byChat.set(row.chat_id, list)
  }
  const waiting: MessageRow[] = []
  for (const list of byChat.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
    const lastClient = [...list].reverse().find((r) => r.sender === 'client')
    if (!lastClient) continue
    const answered = list.some((r) => r.created_at >= lastClient.created_at && r.id !== lastClient.id && isReply(r))
    if (!answered) waiting.push(lastClient)
  }
  return waiting
}

async function runOnce(): Promise<void> {
  const shifts = (await openShifts()).filter((s) => s.staff.telegram_id)
  if (!shifts.length) return

  const admin = createAdminClient()
  const now = Date.now()
  const earliestShift = Math.min(...shifts.map((s) => new Date(s.started_at).getTime()))
  const since = new Date(Math.max(now - LOOKBACK_MS, earliestShift)).toISOString()

  // Якоря и рассылки ответом не считаются — не тянем их вовсе. PostgREST
  // отдаёт не больше 1000 строк за раз, поэтому постранично.
  const data: MessageRow[] = []
  for (let from = 0; from < 10_000; from += 1000) {
    const { data: page, error } = await admin
      .from('chat_messages')
      .select('id, chat_id, sender, author_name, amo_message_id, text, created_at')
      .gte('created_at', since)
      .not('amo_message_id', 'like', 'ga:claim:%')
      .not('amo_message_id', 'like', 'campaign:%')
      .order('id')
      .range(from, from + 999)
    if (error) throw new Error(`chat_messages: ${error.message}`)
    data.push(...((page ?? []) as MessageRow[]))
    if (!page || page.length < 1000) break
  }

  const excluded = await staffPhones()
  const rows = data.filter((r) => /^\d{9,}$/.test(r.chat_id) && !excluded.has(r.chat_id))
  const due = waitingChats(rows).filter((m) => now - new Date(m.created_at).getTime() >= REPLY_REMINDER_AFTER_MS)
  if (!due.length) return

  const phones = [...new Set(due.map((m) => m.chat_id))]
  const { data: deals } = await admin
    .from('deals')
    .select('customer_phone, customer_name')
    .in('customer_phone', phones)
  const nameOf = new Map(((deals ?? []) as { customer_phone: string; customer_name: string | null }[])
    .map((d) => [d.customer_phone, d.customer_name]))

  for (const shift of shifts) {
    // Клиент написал до начала смены — это не пропуск этого сотрудника.
    const mine = due.filter((m) => m.created_at >= shift.started_at)
    if (!mine.length) continue

    const { data: inserted } = await admin
      .from('staff_reply_reminders')
      .upsert(
        mine.map((m) => ({ message_id: m.id, staff_id: shift.staff_id, chat_id: m.chat_id })),
        { onConflict: 'message_id,staff_id', ignoreDuplicates: true }
      )
      .select('message_id')
    const fresh = new Set(((inserted ?? []) as { message_id: number }[]).map((r) => r.message_id))
    const toSend = mine.filter((m) => fresh.has(m.id))
    if (!toSend.length) continue

    const lines = toSend.slice(0, MAX_LISTED).map((m) => {
      const waited = Math.round((now - new Date(m.created_at).getTime()) / 60_000)
      const name = nameOf.get(m.chat_id)
      const snippet = (m.text ?? '').replace(/\[media\]\S+/g, '[файл]').replace(/\s+/g, ' ').trim().slice(0, 80)
      return `• ${name ? `${name}, ` : ''}+${m.chat_id} — ждёт ${waited} мин${snippet ? `\n  «${snippet}»` : ''}`
    })
    const more = toSend.length > MAX_LISTED ? `\n…и ещё ${toSend.length - MAX_LISTED}` : ''
    const title = toSend.length === 1 ? '⏰ Клиент ждёт ответа' : `⏰ ${toSend.length} клиентов ждут ответа`
    await notifyTelegram(shift.staff.telegram_id, `${title}\n\n${lines.join('\n')}${more}`)
  }
}

let started = false

export function startStaffReplyReminders(): void {
  if (started) return
  started = true
  setInterval(() => {
    runOnce().catch((error) => console.error('staff reply reminders failed', error))
  }, POLL_INTERVAL_MS)
}
