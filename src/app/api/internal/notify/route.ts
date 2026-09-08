// ─── POST /api/internal/notify ──────────────────────────────────────────────
// Точка входа для систем вне этого Next.js-приложения: бот (FastAPI) и
// деплой-скрипт на VPS. Защищена общим секретом в заголовке — эти системы
// не имеют и не должны иметь SUPABASE_SERVICE_ROLE_KEY.

import { NextResponse } from 'next/server'
import { notify, type NotificationType } from '@/lib/notifications/notify'
import { matchesRotatableSecret } from '@/lib/webhook-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const VALID_TYPES: readonly NotificationType[] = [
  'kpi_alert', 'kpi_success', 'plan_100', 'absence',
  'salary_ready', 'finance_alert', 'system', 'sale',
  'consultation_booked', 'consultation_reminder', 'sale_lead',
  'server_load', 'deploy', 'security', 'audit',
  'order_new',
]

export async function POST(request: Request) {
  const expectedToken = process.env.INTERNAL_NOTIFY_TOKEN
  if (!expectedToken) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }
  if (!matchesRotatableSecret(request.headers.get('x-internal-token'), 'INTERNAL_NOTIFY_TOKEN')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let payload: {
    type?: string
    title?: string
    body?: string
    actionUrl?: string
    isImportant?: boolean
    sourceType?: string
    sourceId?: string
  }
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!payload.type || !VALID_TYPES.includes(payload.type as NotificationType)) {
    return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
  }
  if (!payload.title || !payload.title.trim()) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 })
  }

  await notify({
    type: payload.type as NotificationType,
    title: payload.title,
    body: payload.body,
    actionUrl: payload.actionUrl,
    isImportant: payload.isImportant,
    sourceType: payload.sourceType,
    sourceId: payload.sourceId,
  })

  return NextResponse.json({ ok: true })
}
