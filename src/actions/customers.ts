'use server'

// Клиенты — агрегат по orders.customer_phone: кто что покупал, сколько раз,
// и возможность написать прямо из списка. Отправка — тот же приём, что
// sendDealMessage (deals.ts): пишем sender='operator' ДО отправки, это тот
// же сигнал «менеджер ведёт чат» — бот сразу перестаёт отвечать этому
// номеру, второй раз включать тумблер вручную не нужно.

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendGreenApiMessage, toGreenApiChatId } from '@/lib/greenapi/client'

async function getViewerName(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  const { data } = await supabase
    .from('employees')
    .select('name')
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .maybeSingle()
  return (data as { name?: string } | null)?.name ?? null
}

export type SendCustomerMessageResult = { success: true } | { success: false; error: string }

export async function sendCustomerMessage(phone: string, text: string): Promise<SendCustomerMessageResult> {
  const name = await getViewerName()
  if (!name) return { success: false, error: 'Нет авторизации' }
  const trimmed = text.trim()
  if (!trimmed) return { success: false, error: 'Пустое сообщение' }
  const digits = phone.replace(/\D/g, '')
  if (!digits) return { success: false, error: 'Некорректный номер' }

  const admin = createAdminClient()
  const messageId = `manager:customer:${digits}:${Date.now()}`
  await admin.from('amocrm_messages').insert({
    amo_message_id: `ga:${messageId}`,
    chat_id: digits,
    direction: 'out',
    sender: 'operator',
    author_name: name,
    text: trimmed,
  })
  try {
    await sendGreenApiMessage(toGreenApiChatId(digits), trimmed)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Не удалось отправить' }
  }
  revalidatePath('/dashboard/customers')
  return { success: true }
}
