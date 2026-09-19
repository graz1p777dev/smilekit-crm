'use server'

// «Кто обслуживал» для карточки сделки: сотрудники, бывшие на смене в
// моменты сообщений человека в чате этого клиента.

import { createAdminClient } from '@/lib/supabase/admin'
import { isFailure, requireAnalytics } from '@/lib/auth-guards'
import { loadClientProfile, type ServedGroup } from '@/lib/analytics/client-profile'

export interface DealServedBy {
  hasChat: boolean
  humanMessages: number
  served: ServedGroup[]
}

/** null — нет прав или у сделки нет номера. */
export async function getDealServedBy(dealId: string): Promise<DealServedBy | null> {
  const guard = await requireAnalytics()
  if (isFailure(guard)) return null

  const { data } = await createAdminClient()
    .from('deals')
    .select('customer_phone')
    .eq('id', dealId)
    .maybeSingle()
  const digits = String((data as { customer_phone?: string | null } | null)?.customer_phone ?? '').replace(/\D/g, '')
  if (digits.length < 9) return null

  const profile = await loadClientProfile(digits)
  return { hasChat: profile.hasChat, humanMessages: profile.humanMessages, served: profile.served }
}
