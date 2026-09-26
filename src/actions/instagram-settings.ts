'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import {
  getInstagramIntegration,
  disconnectInstagram,
  setInstagramBotSettings,
  type InstagramBotSettings,
  type InstagramIntegration,
} from '@/lib/instagram/config'
import { createAdminClient } from '@/lib/supabase/admin'

export type ActionResult = { success: true } | { success: false; error: string }

async function requireOwner(): Promise<boolean> {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return false
  const { data } = await supabase.from('employees').select('role').eq('user_id', session.user.id).single()
  return data?.role === 'owner'
}

export async function getInstagramStatus(): Promise<InstagramIntegration | null> {
  if (!(await requireOwner())) return null
  return getInstagramIntegration()
}

/** Тумблеры «бот отвечает в директе» и «бот отвечает в комментариях» — каждый отдельно. */
export async function setInstagramBotSettingsAction(
  settings: Partial<InstagramBotSettings>
): Promise<ActionResult> {
  if (!(await requireOwner())) return { success: false, error: 'Недостаточно прав' }
  await setInstagramBotSettings(settings)
  revalidatePath('/dashboard/settings')
  return { success: true }
}

export interface InstagramCommentRow {
  id: string
  comment_id: string
  author_username: string | null
  text: string
  commented_at: string | null
  reply_text: string | null
  private_reply_sent: boolean
  status: string
}

/** Последние комментарии под постами и что бот на них ответил — вкладка Настройки → Instagram. */
export async function listInstagramComments(): Promise<InstagramCommentRow[]> {
  if (!(await requireOwner())) return []
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('instagram_comments')
    .select('id, comment_id, author_username, text, commented_at, reply_text, private_reply_sent, status')
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) {
    console.error('instagram settings: list comments failed', error.message)
    return []
  }
  return (data ?? []) as InstagramCommentRow[]
}

export async function disconnectInstagramAction(): Promise<ActionResult> {
  if (!(await requireOwner())) return { success: false, error: 'Недостаточно прав' }
  await disconnectInstagram()
  revalidatePath('/dashboard/settings')
  return { success: true }
}
