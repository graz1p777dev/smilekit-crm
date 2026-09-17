// Общее для /api/internal/staff/* — эти запросы шлёт Telegram-бот (/staffs).
// Секрет тот же, что у заказов от бота: INTERNAL_NOTIFY_TOKEN.

import { NextResponse } from 'next/server'
import { matchesRotatableSecret } from '@/lib/webhook-auth'

export function rejectUnauthorized(request: Request): NextResponse | null {
  if (!process.env.INTERNAL_NOTIFY_TOKEN) {
    return NextResponse.json({ ok: false, error: 'Not configured' }, { status: 503 })
  }
  if (!matchesRotatableSecret(request.headers.get('x-internal-token'), 'INTERNAL_NOTIFY_TOKEN')) {
    return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
  }
  return null
}

/** Тело запроса и telegramId из него; null — тело негодное. */
export async function readBody(request: Request): Promise<{ telegramId: number; body: Record<string, unknown> } | null> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const telegramId = body?.telegramId
  if (!body || typeof telegramId !== 'number' || !Number.isSafeInteger(telegramId)) return null
  return { telegramId, body }
}

export const badRequest = () => NextResponse.json({ ok: false, error: 'Неверный запрос' }, { status: 400 })
export const notLoggedIn = () =>
  NextResponse.json({ ok: false, error: 'Вы не вошли. Отправьте /staffs и введите пароль.' }, { status: 401 })
