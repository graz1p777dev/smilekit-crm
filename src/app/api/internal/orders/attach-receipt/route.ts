// ─── POST /api/internal/orders/attach-receipt ───────────────────────────────
// Telegram-бот зовёт этот эндпоинт, когда клиент прислал чек (подтверждённый
// или нет) — CRM должна показать его менеджеру в карточке заказа, а не только
// в Telegram-группе доставки. Заказ создаётся раньше (push_order, ещё до
// чека), поэтому здесь только обновление — ищем последний заказ этого чата.
//
// Ссылка на чек хранится маркером в summary, как и в WhatsApp-канале (см.
// MEDIA_MARKER в src/actions/deals.ts) — отдельной колонки под вложения в
// orders нет.

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { matchesRotatableSecret } from '@/lib/webhook-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  const expectedToken = process.env.INTERNAL_NOTIFY_TOKEN
  if (!expectedToken) return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  if (!matchesRotatableSecret(request.headers.get('x-internal-token'), 'INTERNAL_NOTIFY_TOKEN')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  const telegramChatId = body?.telegramChatId
  const mediaUrl = body?.mediaUrl
  if (typeof telegramChatId !== 'number' || typeof mediaUrl !== 'string' || !mediaUrl) {
    return NextResponse.json({ error: 'telegramChatId and mediaUrl are required' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: order } = await admin
    .from('orders')
    .select('id, summary')
    .eq('telegram_chat_id', telegramChatId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!order) return NextResponse.json({ error: 'order_not_found' }, { status: 404 })

  const summary = (order as { summary: string | null }).summary ?? ''
  const withoutOldMarker = summary.replace(/\n\[media\]\S+$/, '')
  const { error } = await admin
    .from('orders')
    .update({ summary: `${withoutOldMarker}\n[media]${mediaUrl}` })
    .eq('id', (order as { id: string }).id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
