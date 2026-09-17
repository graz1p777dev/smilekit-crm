import { NextResponse } from 'next/server'
import { bindTelegram, loginStaff } from '@/lib/staff/service'
import { badRequest, readBody, rejectUnauthorized } from '../_shared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  const denied = rejectUnauthorized(request)
  if (denied) return denied
  const parsed = await readBody(request)
  const password = parsed?.body.password
  if (!parsed || typeof password !== 'string') return badRequest()

  // Попытки считаем на Telegram-аккаунт: 5 неверных — блок на 5 минут.
  const result = await loginStaff(`tg:${parsed.telegramId}`, password)
  if (!result.ok) {
    const { ok, status, error, ...extra } = result
    return NextResponse.json({ ok, error, ...extra }, { status })
  }
  await bindTelegram(result.staff.id, parsed.telegramId)
  return NextResponse.json({ ok: true, staff: { id: result.staff.id, fullName: result.staff.full_name } })
}
