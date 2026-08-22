'use server'

// Настройки WhatsApp-канала (Green API): шаблоны сообщений, группа доставки,
// внешние CRM-вебхуки, товароучёт. Хранение — settings.extra, см.
// src/lib/greenapi/config.ts. Доступ только владельцу — тот же уровень,
// что у промптов бота (bot-settings).

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { getWhatsappBotConfig, saveWhatsappBotConfig, type WhatsappBotConfig } from '@/lib/greenapi/config'
import { listGreenApiGroups, type GreenApiGroup } from '@/lib/greenapi/client'

export async function requireOwner(): Promise<boolean> {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return false
  const { data } = await supabase
    .from('employees')
    .select('role')
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .maybeSingle()
  return (data as { role?: string } | null)?.role === 'owner'
}

export async function getWhatsappSettings(): Promise<WhatsappBotConfig | null> {
  if (!(await requireOwner())) return null
  return getWhatsappBotConfig()
}

export async function updateWhatsappSettings(
  patch: Partial<WhatsappBotConfig>
): Promise<{ success: true } | { success: false; error: string }> {
  if (!(await requireOwner())) return { success: false, error: 'Нет доступа' }
  const result = await saveWhatsappBotConfig(patch)
  if (result.success) revalidatePath('/dashboard/whatsapp-settings')
  return result
}

export async function searchWhatsappGroups(query: string): Promise<
  { success: true; groups: GreenApiGroup[] } | { success: false; error: string }
> {
  if (!(await requireOwner())) return { success: false, error: 'Нет доступа' }
  try {
    const groups = await listGreenApiGroups()
    const normalized = query.trim().toLowerCase()
    const filtered = normalized
      ? groups.filter((g) => g.name.toLowerCase().includes(normalized))
      : groups
    return { success: true, groups: filtered }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Не удалось получить список групп' }
  }
}
