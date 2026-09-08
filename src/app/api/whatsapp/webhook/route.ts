import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { upsertDealFromInbound } from '@/lib/deals/auto-create'
import { isBodyTooLarge, matchesRotatableSecret } from '@/lib/webhook-auth'
import { checkRateLimit, getClientIp } from '@/lib/rate-limit'

// Wazzup24 webhook — регистрируется через PATCH https://api.wazzup24.com/v3/webhooks
// с webhooksUri вида https://<домен-CRM>/api/whatsapp/webhook?secret=...
// Секрет в query string — единственная проверка, что запрос реально от Wazzup
// (сам Wazzup ничего не подписывает).
//
// Без timestamp-поля в payload'е Wazzup защита от replay-атак здесь не
// работает — делать её не из чего.

interface WazzupMessage {
  messageId: string
  chatId: string
  chatType: string
  type: string
  isEcho?: boolean
  text?: string
  status: string
}

export async function POST(request: NextRequest) {
  if (isBodyTooLarge(request)) {
    return NextResponse.json({ error: 'Payload Too Large' }, { status: 413 })
  }

  const ip = getClientIp(request)
  const perIp = checkRateLimit(`whatsapp-webhook:ip:${ip}`, { windowMs: 60_000, max: 60 })
  if (!perIp.allowed) {
    return NextResponse.json({ error: 'Too Many Requests' }, { status: 429, headers: { 'Retry-After': String(perIp.retryAfterSeconds) } })
  }
  // Общий предохранитель на все IP разом — на случай распределённой атаки.
  const global = checkRateLimit('whatsapp-webhook:global', { windowMs: 60_000, max: 300 })
  if (!global.allowed) {
    return NextResponse.json({ error: 'Too Many Requests' }, { status: 429, headers: { 'Retry-After': String(global.retryAfterSeconds) } })
  }

  const secret = request.nextUrl.searchParams.get('secret')
  if (!matchesRotatableSecret(secret, 'WAZZUP_WEBHOOK_SECRET')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const messages: WazzupMessage[] = body?.messages ?? []

  const rows = messages
    .filter(m => m.chatType === 'whatsapp' && !m.isEcho)
    .map(m => ({
      phone: m.chatId,
      direction: m.status === 'inbound' ? 'in' as const : 'out' as const,
      text: m.type === 'text' ? (m.text ?? '') : `[${m.type}]`,
      wazzup_message_id: m.messageId,
    }))

  if (rows.length > 0) {
    const supabase = createAdminClient()
    const { error } = await supabase.from('whatsapp_messages').insert(rows)
    if (error) {
      // Wazzup ретраит на ошибку — логируем, но не роняем 200, чтобы не зациклиться
      // на одном и том же сообщении при временном сбое БД.
      console.error('whatsapp webhook insert failed', error)
    }
  }

  // Входящее от нового номера — заводим сделку в «Неразобранном».
  // Исходящие (direction 'out') и эхо менеджера сделку не создают.
  // Идемпотентность на UNIQUE deals.external_key, поэтому по номеру
  // достаточно одной попытки на каждое сообщение.
  const inboundPhones = [...new Set(rows.filter(r => r.direction === 'in').map(r => r.phone))]
  for (const phone of inboundPhones) {
    const result = await upsertDealFromInbound({
      externalKey: `wazzup:${phone}`,
      source: 'whatsapp',
      customerPhone: phone,
    })
    if (result.error) console.error('whatsapp webhook deal upsert failed', phone, result.error)
  }

  return NextResponse.json({ ok: true })
}
