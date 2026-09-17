// Пароли и сессии сотрудников смен. Только серверный код.
//
// Вход идёт по одному паролю, без имени, — значит, сотрудника надо найти по
// паролю. Поэтому хеш детерминированный (HMAC с секретом сервера), а не
// соль на каждую запись: иначе пришлось бы перебирать всех. Секрет
// STAFF_PASSWORD_PEPPER живёт только в переменных Railway — утёкшая таблица
// без него пароли не выдаёт.

import { createHmac, randomBytes } from 'crypto'
import { safeEqual } from '@/lib/webhook-auth'

function pepper(): string {
  const value = process.env.STAFF_PASSWORD_PEPPER
  if (!value) throw new Error('STAFF_PASSWORD_PEPPER не задан')
  return value
}

export function hashStaffPassword(password: string): string {
  return createHmac('sha256', pepper()).update(`password:${password.trim()}`).digest('hex')
}

export function newRequestToken(): string {
  return randomBytes(24).toString('base64url')
}

export const STAFF_SESSION_COOKIE = 'smena_session'
/** Смена длится до 12 часов — сессии хватает на смену с запасом. */
export const STAFF_SESSION_MAX_AGE_S = 16 * 3600

function sign(payload: string): string {
  return createHmac('sha256', pepper()).update(`session:${payload}`).digest('base64url')
}

export function createStaffSession(staffId: string, now = Date.now()): string {
  const payload = `${staffId}.${now + STAFF_SESSION_MAX_AGE_S * 1000}`
  return `${payload}.${sign(payload)}`
}

/** id сотрудника из cookie или null, если подпись не сошлась или срок вышел. */
export function readStaffSession(value: string | undefined, now = Date.now()): string | null {
  if (!value) return null
  const [staffId, expires, signature] = value.split('.')
  if (!staffId || !expires || !signature) return null
  if (!safeEqual(signature, sign(`${staffId}.${expires}`))) return null
  if (Number(expires) < now) return null
  return staffId
}
