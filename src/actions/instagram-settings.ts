'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getInstagramIntegration, disconnectInstagram, type InstagramIntegration } from '@/lib/instagram/config'

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

export async function disconnectInstagramAction(): Promise<ActionResult> {
  if (!(await requireOwner())) return { success: false, error: 'Недостаточно прав' }
  await disconnectInstagram()
  revalidatePath('/dashboard/instagram-settings')
  return { success: true }
}
