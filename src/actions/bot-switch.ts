// ВНИМАНИЕ: строка в таблице integrations по-прежнему называется 'amoCRM'.
// Это исторический ключ аварийного выключателя WhatsApp-бота (Green API):
// переименовать его можно только вместе с UPDATE в базе, иначе шлюз перестанет
// находить строку и бот замолчит для всех клиентов.
'use server'

// Аварийный выключатель бота amoCRM (WhatsApp-канал). Флаг
// integrations.amoCRM.is_active (с учётом paused_until — см.
// src/lib/integration-status.ts) читается на каждое входящее сообщение
// (src/lib/greenapi/bot-reply.ts): выключен — бот молчит мгновенно, история
// пишется и этапы сделок двигаются дальше.
//
// Управлять им может только owner/rop (isAllowedBotControlRole) — раньше
// проверки не было вообще, любой авторизованный запрос мог заглушить бота
// во всех чатах. Каждое изменение пишется в audit_logs (recordAudit).

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { recordAudit } from '@/actions/audit'
import { isAllowedBotControlRole } from '@/lib/bot-control-roles'

type ActionResult = { success: true } | { success: false; error: string }

async function getViewerRole(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  const { data } = await supabase
    .from('employees')
    .select('role')
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .maybeSingle()
  return (data as { role?: string } | null)?.role ?? null
}

export async function getBotEnabled(): Promise<
  { success: true; enabled: boolean } | { success: false; error: string }
> {
  const supabase = createAdminClient()
  const { data, error } = await supabase.from('integrations').select('is_active').eq('name', 'amoCRM').maybeSingle()
  if (error) return { success: false, error: error.message }
  return { success: true, enabled: Boolean((data as { is_active?: boolean } | null)?.is_active) }
}

export async function setBotEnabled(enabled: boolean): Promise<ActionResult> {
  const role = await getViewerRole()
  if (!isAllowedBotControlRole(role)) return { success: false, error: 'Недостаточно прав' }

  const supabase = createAdminClient()
  const { data: before } = await supabase
    .from('integrations')
    .select('id, is_active')
    .eq('name', 'amoCRM')
    .maybeSingle()

  const { error } = await supabase
    .from('integrations')
    .update({ is_active: enabled, updated_at: new Date().toISOString() })
    .eq('name', 'amoCRM')
  if (error) return { success: false, error: error.message }

  const beforeRow = before as { id?: string; is_active?: boolean } | null
  await recordAudit({
    action: 'update',
    resourceType: 'integration',
    resourceId: beforeRow?.id ?? null,
    summary: `Бот amoCRM: ${beforeRow?.is_active ? 'вкл' : 'выкл'} → ${enabled ? 'вкл' : 'выкл'}`,
  })

  return { success: true }
}

/**
 * Временная пауза бота вместо полного выключения.
 * durationMinutes — число: пауза на N минут, is_active не трогаем, бот сам
 * возобновится по истечении paused_until (см. isIntegrationBotEnabled).
 * durationMinutes === null — «до ручного включения», это ровно
 * setBotEnabled(false) — переиспользуем его логику и проверки.
 */
export async function pauseBot(durationMinutes: number | null): Promise<ActionResult> {
  if (durationMinutes === null) return setBotEnabled(false)

  const role = await getViewerRole()
  if (!isAllowedBotControlRole(role)) return { success: false, error: 'Недостаточно прав' }

  const supabase = createAdminClient()
  const { data: before } = await supabase
    .from('integrations')
    .select('id')
    .eq('name', 'amoCRM')
    .maybeSingle()

  const pausedUntil = new Date(Date.now() + durationMinutes * 60_000).toISOString()
  const { error } = await supabase
    .from('integrations')
    .update({ paused_until: pausedUntil, updated_at: new Date().toISOString() })
    .eq('name', 'amoCRM')
  if (error) return { success: false, error: error.message }

  const beforeRow = before as { id?: string } | null
  await recordAudit({
    action: 'update',
    resourceType: 'integration',
    resourceId: beforeRow?.id ?? null,
    summary: `Бот amoCRM поставлен на паузу на ${durationMinutes} мин. (до ${pausedUntil})`,
  })

  return { success: true }
}
