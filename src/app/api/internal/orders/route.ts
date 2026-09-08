// ─── POST /api/internal/orders ──────────────────────────────────────────────
// Telegram-бот Smilekit зовёт этот эндпоинт, когда клиент действительно
// оформил заказ: в CRM появляется заказ в статусе «Новый» и уведомление
// менеджерам. Защита — тот же общий секрет, что у /api/internal/notify и
// /api/internal/deals: у бота нет и не должно быть SUPABASE_SERVICE_ROLE_KEY.
//
// Вызов у бота fire-and-forget: если CRM недоступна, клиент всё равно
// получит ответ, а бот запишет провал в лог.

import { NextResponse } from 'next/server'
import { ingestOrder } from '@/lib/orders/ingest'
import { recordEvent } from '@/lib/control-center'
import { matchesRotatableSecret } from '@/lib/webhook-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  const expectedToken = process.env.INTERNAL_NOTIFY_TOKEN
  if (!expectedToken) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }
  if (!matchesRotatableSecret(request.headers.get('x-internal-token'), 'INTERNAL_NOTIFY_TOKEN')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const body = payload as Record<string, unknown>
  if (typeof body.externalKey !== 'string' || !body.externalKey.trim()) {
    return NextResponse.json({ error: 'externalKey is required' }, { status: 400 })
  }

  // Остальные поля не проверяем здесь по одному: normalizeOrder() внутри
  // ingestOrder() режет их по длине и диапазону, а неразобранное обнуляет.
  // try/catch — чтобы бот всегда получал JSON, а не пустую 500: без ключей
  // окружения createAdminClient() бросает, и без обёртки ответ был бы пустым.
  let result
  try {
    result = await ingestOrder({
      externalKey: body.externalKey,
      source: body.source as string | null,
      customerName: body.customerName as string | null,
      customerPhone: body.customerPhone as string | null,
      customerUsername: body.customerUsername as string | null,
      telegramChatId: body.telegramChatId as number | string | null,
      quantity: body.quantity as number | string | null,
      unitPrice: body.unitPrice as number | string | null,
      totalAmount: body.totalAmount as number | string | null,
      currency: body.currency as string | null,
      city: body.city as string | null,
      summary: body.summary as string | null,
    })
  } catch (err) {
    console.error('internal/orders ingest threw', err)
    recordEvent({ type: 'error', level: 'error', title: 'internal/orders ingest threw' })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  if (result.error) {
    console.error('internal/orders ingest failed', result.error)
    recordEvent({ type: 'error', level: 'error', title: 'internal/orders ingest failed' })
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  return NextResponse.json({ ok: true, created: result.created, id: result.id })
}
