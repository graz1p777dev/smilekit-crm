'use server'

// Профиль клиента для карточек (тип клиента, покупки, кто обслуживал).
// Вкладки «Аналитики» грузятся не отсюда, а через GET /api/analytics/<вкладка>
// (см. src/app/api/analytics/[tab]/route.ts).

import { isFailure, requireManagement } from '@/lib/auth-guards'
import { loadClientProfile, type ClientProfile } from '@/lib/analytics/client-profile'

export type { ClientProfile, ServedGroup } from '@/lib/analytics/client-profile'

export async function getClientProfile(phone: string): Promise<ClientProfile | null> {
  const result = await requireManagement()
  if (isFailure(result)) return null
  const digits = String(phone ?? '').replace(/\D/g, '')
  if (digits.length < 9) return null
  return loadClientProfile(digits)
}
