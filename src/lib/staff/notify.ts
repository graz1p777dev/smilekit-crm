// Куда уходят уведомления смен: сотруднику — в Telegram (бот, /staffs),
// подтверждение передачи смены — ещё и в WhatsApp заменяемому и владельцу.
// Сбой одного канала не должен ронять действие со сменой: сама смена уже
// записана, уведомление — вторично. Поэтому ошибки только в лог.

import { createAdminClient } from '@/lib/supabase/admin'
import { smilekitBotFetch } from '@/lib/smilekit-bot-api'
import { sendGreenApiMessage, toGreenApiChatId } from '@/lib/greenapi/client'

export interface TelegramButton {
  text: string
  callbackData: string
}

export async function notifyTelegram(telegramId: number | null, text: string, buttons?: TelegramButton[]): Promise<void> {
  if (!telegramId) return
  const result = await smilekitBotFetch('/internal/staff/notify', {
    method: 'POST',
    body: { telegramId, text, buttons },
  })
  if (!result.ok) console.error('staff notify telegram failed', result.status, result.error)
}

export async function notifyWhatsapp(phone: string | null, text: string): Promise<void> {
  if (!phone) return
  try {
    await sendGreenApiMessage(toGreenApiChatId(phone), text)
  } catch (error) {
    console.error('staff notify whatsapp failed', error)
  }
}

export interface StaffShiftSettings {
  ownerWhatsapp: string | null
}

export async function readStaffShiftSettings(): Promise<StaffShiftSettings> {
  const admin = createAdminClient()
  const { data } = await admin.from('settings').select('extra').limit(1).maybeSingle()
  const raw = (data as { extra?: Record<string, unknown> } | null)?.extra?.staffShifts as
    | { ownerWhatsapp?: unknown }
    | undefined
  return {
    ownerWhatsapp: typeof raw?.ownerWhatsapp === 'string' && raw.ownerWhatsapp ? raw.ownerWhatsapp : null,
  }
}

/** Публичный адрес CRM для ссылок в WhatsApp. */
export function publicAppUrl(): string {
  const host = process.env.PUBLIC_APP_URL || process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:3000'
  return host.startsWith('http') ? host.replace(/\/$/, '') : `https://${host}`
}
