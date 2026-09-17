'use server'

// Страница /smena — вход сотрудника смены по паролю, без учётной записи CRM.
// Сессия — подписанная cookie (src/lib/staff/crypto.ts). Попытки считаем на
// IP: 5 неверных паролей — блок на 5 минут.

import { cookies, headers } from 'next/headers'
import {
  createStaffSession, readStaffSession, STAFF_SESSION_COOKIE, STAFF_SESSION_MAX_AGE_S,
} from '@/lib/staff/crypto'
import {
  activeStaffById, decideShiftRequest, findRequestByToken, getStaffState, loginStaff,
  performStaffAction, type StaffAction, type StaffState,
} from '@/lib/staff/service'
import { getClientIp } from '@/lib/rate-limit'

export type PortalResult = { ok: true; message?: string } | { ok: false; error: string }

async function currentStaff() {
  const store = await cookies()
  const staffId = readStaffSession(store.get(STAFF_SESSION_COOKIE)?.value)
  return staffId ? activeStaffById(staffId) : null
}

export async function staffPortalLogin(password: string): Promise<{ ok: true; fullName: string } | { ok: false; error: string }> {
  if (typeof password !== 'string') return { ok: false, error: 'Введите пароль' }
  const ip = getClientIp({ headers: await headers() })
  const result = await loginStaff(`ip:${ip}`, password)
  if (!result.ok) {
    const left = 'attemptsLeft' in result && result.attemptsLeft !== undefined
      ? ` Осталось попыток: ${result.attemptsLeft}.`
      : ''
    return { ok: false, error: `${result.error}.${left}`.replace('..', '.') }
  }
  const store = await cookies()
  store.set(STAFF_SESSION_COOKIE, createStaffSession(result.staff.id), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/smena',
    maxAge: STAFF_SESSION_MAX_AGE_S,
  })
  return { ok: true, fullName: result.staff.full_name }
}

export async function staffPortalLogout(): Promise<void> {
  const store = await cookies()
  store.delete({ name: STAFF_SESSION_COOKIE, path: '/smena' })
}

export async function staffPortalState(): Promise<StaffState> {
  return getStaffState(await currentStaff())
}

export async function staffPortalAction(action: StaffAction): Promise<PortalResult> {
  if (!['take', 'join', 'close', 'cancel_request'].includes(action)) return { ok: false, error: 'Неизвестное действие' }
  const staff = await currentStaff()
  if (!staff) return { ok: false, error: 'Сессия закончилась — войдите снова' }
  const result = await performStaffAction(staff, action, 'web')
  return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error }
}

export async function staffPortalDecide(requestId: string, decision: 'approve' | 'reject'): Promise<PortalResult> {
  if (decision !== 'approve' && decision !== 'reject') return { ok: false, error: 'Неизвестное решение' }
  const staff = await currentStaff()
  if (!staff) return { ok: false, error: 'Сессия закончилась — войдите снова' }
  const result = await decideShiftRequest(requestId, { kind: 'staff', staffId: staff.id }, decision)
  return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error }
}

/**
 * Решение по ссылке из WhatsApp. Ссылка уходит только тому, кого заменяют, и
 * владельцу; её секрет — 24 случайных байта, поэтому сама ссылка и есть право
 * подтвердить.
 */
export async function decideByToken(token: string, decision: 'approve' | 'reject'): Promise<PortalResult> {
  if (typeof token !== 'string' || (decision !== 'approve' && decision !== 'reject')) {
    return { ok: false, error: 'Неверная ссылка' }
  }
  const request = await findRequestByToken(token)
  if (!request) return { ok: false, error: 'Ссылка не найдена' }
  const result = await decideShiftRequest(request.id, { kind: 'link' }, decision)
  return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error }
}
