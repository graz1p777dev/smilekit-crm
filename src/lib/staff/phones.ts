// Телефоны сотрудников смен. Сотрудник получает на свой WhatsApp ссылку
// подтверждения с рабочего номера и может ответить на неё — такой чат не
// лид: бот не должен продавать сотруднику, а аналитика не должна считать его
// клиентом. Кэш на минуту — вебхук WhatsApp вызывается на каждое сообщение.

import { createAdminClient } from '@/lib/supabase/admin'

const TTL_MS = 60_000
let cache: { at: number; phones: Set<string> } | null = null

export async function staffPhones(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.phones
  const { data, error } = await createAdminClient().from('staff_members').select('phone')
  // Нет таблицы или сбой чтения — не роняем приём сообщений клиентов.
  if (error) return cache?.phones ?? new Set()
  cache = { at: Date.now(), phones: new Set(((data ?? []) as { phone: string }[]).map((r) => r.phone)) }
  return cache.phones
}
