// Статусы доставки рассылки из вебхука Green API outgoingMessageStatus:
// sent → delivered → read. Привязка — по id сообщения, который планировщик
// сохранил у получателя (campaign_recipients.provider_message_id).

import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Какие поля выставить по статусу. «Прочитано» подразумевает «доставлено»:
 * WhatsApp иногда присылает read без отдельного delivered.
 */
export function deliveryPatch(status: string | undefined, at: string): { delivered_at?: string; read_at?: string } | null {
  if (status === 'delivered') return { delivered_at: at }
  if (status === 'read') return { delivered_at: at, read_at: at }
  return null
}

export async function recordCampaignDeliveryStatus(idMessage: string, status: string | undefined, timestampSec?: number) {
  const at = new Date(timestampSec ? timestampSec * 1000 : Date.now()).toISOString()
  const patch = deliveryPatch(status, at)
  if (!patch) return
  const admin = createAdminClient()
  // Время не перезаписываем: первое «доставлено» и первое «прочитано» — факт.
  if (patch.delivered_at) {
    await admin.from('campaign_recipients').update({ delivered_at: patch.delivered_at })
      .eq('provider_message_id', idMessage).is('delivered_at', null)
  }
  if (patch.read_at) {
    await admin.from('campaign_recipients').update({ read_at: patch.read_at })
      .eq('provider_message_id', idMessage).is('read_at', null)
  }
}
