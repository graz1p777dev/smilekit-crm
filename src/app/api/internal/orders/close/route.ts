// ─── POST /api/internal/orders/close ────────────────────────────────────────
// Telegram-бот зовёт этот эндпоинт, когда курьер реагирует (лайком или любой
// другой реакцией) на сообщение с заказом в группе доставки — сигнал «заказ
// доставлен». Тот же общий секрет, что у /api/internal/orders и
// /api/internal/notify.

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  const expectedToken = process.env.INTERNAL_NOTIFY_TOKEN
  if (!expectedToken) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }
  if (request.headers.get('x-internal-token') !== expectedToken) {
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
  const externalKey = typeof body.externalKey === 'string' ? body.externalKey.trim() : ''
  if (!externalKey) {
    return NextResponse.json({ error: 'externalKey is required' }, { status: 400 })
  }

  const supabase = createAdminClient()
  const { error, data } = await supabase
    .from('orders')
    .update({ status: 'delivered' })
    .eq('external_key', externalKey)
    .select('id')
  if (error) {
    console.error('internal/orders/close: update failed', error.message)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, updated: data?.length ?? 0 })
}
