'use server'

// «Здоровье бота» — вкладка Настройки → WhatsApp. Только владелец.
// Показывает, жив ли движок, сколько клиентов ждут ответа, журнал проблем
// за 3 дня, и запускает восстановление после сбоя.

import { createAdminClient } from '@/lib/supabase/admin'
import { requireOwner } from '@/actions/whatsapp-settings'
import { getGreenApiState } from '@/lib/greenapi/client'
import { findUnansweredChats, getRecoveryState, startRecovery, type RecoveryState } from '@/lib/greenapi/recovery'
import { memorySnapshot } from '@/lib/greenapi/watchdog'

export interface BotLogRow {
  id: number
  created_at: string
  channel: string
  chat_id: string | null
  event: string
  level: string
  details: Record<string, unknown>
}

export interface BotHealth {
  greenApi: string
  engine: { lastOkAt: string | null; failedLast15Min: number; okLast15Min: number }
  last24h: { inbound: number; sent: number; sendFailed: number; engineFailed: number }
  retriesPending: number
  waiting: { chatId: string; ageMin: number; messages: number; preview: string; botCanReply: boolean }[]
  problems: BotLogRow[]
  memory: { rssMb: number; heapMb: number }
  recovery: RecoveryState
}

async function countEvents(event: string, sinceIso: string): Promise<number> {
  const { count } = await createAdminClient()
    .from('bot_event_log')
    .select('id', { count: 'exact', head: true })
    .eq('event', event)
    .gte('created_at', sinceIso)
  return count ?? 0
}

export async function getBotHealth(): Promise<BotHealth | null> {
  if (!(await requireOwner())) return null
  const supabase = createAdminClient()
  const since24 = new Date(Date.now() - 86_400_000).toISOString()
  const since15 = new Date(Date.now() - 15 * 60_000).toISOString()

  const [greenApi, waiting, lastOk, failed15, ok15, inbound, sent, sendFailed, engineFailed, retries, problems] = await Promise.all([
    getGreenApiState().catch(() => 'недоступен'),
    findUnansweredChats(supabase, { withGate: true }).catch(() => []),
    supabase.from('bot_event_log').select('created_at').eq('event', 'engine_ok').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    countEvents('engine_failed', since15),
    countEvents('engine_ok', since15),
    countEvents('inbound', since24),
    countEvents('sent', since24),
    countEvents('send_failed', since24),
    countEvents('engine_failed', since24),
    supabase.from('wa_engine_retries').select('message_id', { count: 'exact', head: true }).is('done_at', null),
    supabase.from('bot_event_log').select('id, created_at, channel, chat_id, event, level, details').neq('level', 'info').order('created_at', { ascending: false }).limit(40),
  ])

  return {
    greenApi,
    engine: { lastOkAt: (lastOk.data as { created_at: string } | null)?.created_at ?? null, failedLast15Min: failed15, okLast15Min: ok15 },
    last24h: { inbound, sent, sendFailed, engineFailed },
    retriesPending: retries.count ?? 0,
    waiting: waiting.slice(0, 50).map(({ chatId, ageMin, messages, preview, botCanReply }) => ({ chatId, ageMin, messages, preview, botCanReply })),
    problems: (problems.data ?? []) as BotLogRow[],
    memory: memorySnapshot(),
    recovery: getRecoveryState(),
  }
}

export async function getChatLog(chatId: string): Promise<BotLogRow[]> {
  if (!(await requireOwner())) return []
  const { data } = await createAdminClient()
    .from('bot_event_log')
    .select('id, created_at, channel, chat_id, event, level, details')
    .eq('chat_id', chatId.replace(/\D/g, ''))
    .order('created_at', { ascending: false })
    .limit(100)
  return (data ?? []) as BotLogRow[]
}

export async function recoverAfterOutage(): Promise<{ success: true; total: number } | { success: false; error: string }> {
  if (!(await requireOwner())) return { success: false, error: 'Нет доступа' }
  const chats = await findUnansweredChats(createAdminClient(), { withGate: true })
  const result = startRecovery(chats)
  if (!result.started) return { success: false, error: 'Восстановление уже идёт' }
  if (result.total === 0) return { success: false, error: 'Нет чатов, на которые бот может ответить' }
  return { success: true, total: result.total }
}
