import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { performStaffAction, staffByTelegram, type StaffAction } from '@/lib/staff/service'
import { badRequest, notLoggedIn, readBody, rejectUnauthorized } from '../_shared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const ACTIONS: readonly (StaffAction | 'logout')[] = ['take', 'join', 'close', 'cancel_request', 'logout']

export async function POST(request: Request) {
  const denied = rejectUnauthorized(request)
  if (denied) return denied
  const parsed = await readBody(request)
  const action = parsed?.body.action as StaffAction | 'logout' | undefined
  if (!parsed || !action || !ACTIONS.includes(action)) return badRequest()

  const staff = await staffByTelegram(parsed.telegramId)
  if (!staff) return notLoggedIn()

  if (action === 'logout') {
    // Выход снимает только привязку Telegram — смена, если открыта, идёт дальше.
    await createAdminClient().from('staff_members').update({ telegram_id: null }).eq('id', staff.id)
    return NextResponse.json({ ok: true, result: 'logged_out', message: 'Вы вышли. Чтобы войти снова — /staffs' })
  }

  const result = await performStaffAction(staff, action, 'telegram')
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
  return NextResponse.json(result)
}
