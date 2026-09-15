'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Notification } from '@/types'

export type ActionResult = { success: true } | { success: false; error: string }

async function requireSession() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

export async function getNotifications(filter: 'all' | 'important' = 'all'): Promise<Notification[]> {
  const session = await requireSession()
  if (!session) return []

  const supabase = await createClient()
  let query = supabase
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100)

  if (filter === 'important') {
    query = query.eq('is_important', true)
  }

  const { data } = await query
  const notifications = (data ?? []) as Notification[]

  if (filter === 'important') return notifications

  const admin = createAdminClient()
  const { data: messages } = await admin
    .from('chat_messages')
    .select('id, chat_id, lead_id, contact_id, sender, author_name, text, created_at')
    .order('created_at', { ascending: false })
    .limit(200)

  const clientByChat = new Map<string, string>()
  for (const message of messages ?? []) {
    if (message.sender === 'client' && message.author_name && !clientByChat.has(message.chat_id)) {
      clientByChat.set(message.chat_id, message.author_name)
    }
  }

  const botReplies: Notification[] = (messages ?? [])
    .filter(message => message.sender === 'bot')
    .slice(0, 100)
    .map(message => ({
      id: `bot-reply-${message.id}`,
      employee_id: session.user.id,
      type: 'bot_reply',
      title: `Ответ бота → ${clientByChat.get(message.chat_id) ?? `лид ${message.lead_id ?? 'amoCRM'}`}`,
      body: message.text,
      action_url: null,
      is_read: true,
      is_important: false,
      source_type: 'amocrm_bot_reply',
      source_id: message.contact_id,
      created_at: message.created_at,
    }))

  return [...notifications, ...botReplies]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, 100)
}

export async function markNotificationRead(id: string): Promise<ActionResult> {
  const session = await requireSession()
  if (!session) return { success: false, error: 'Нет доступа' }

  const supabase = await createClient()
  const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', id)
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/notifications')
  return { success: true }
}

export async function markAllNotificationsRead(): Promise<ActionResult> {
  const session = await requireSession()
  if (!session) return { success: false, error: 'Нет доступа' }

  const supabase = await createClient()
  const { error } = await supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('is_read', false)
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/notifications')
  return { success: true }
}
