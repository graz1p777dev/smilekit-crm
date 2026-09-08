import { after, NextRequest, NextResponse } from 'next/server'
import { upsertDealFromInbound } from '@/lib/deals/auto-create'
import { processInboundAmoMessage, registerOutgoingAmoMessage } from '@/lib/amocrm/bot-reply'
import { isBodyTooLarge, matchesRotatableSecret } from '@/lib/webhook-auth'
import { checkRateLimit, getClientIp } from '@/lib/rate-limit'

// Вебхук amoCRM (Настройки → Интеграции → Webhooks на towhite.amocrm.ru).
// Секрет в query string — единственная проверка, что запрос от amoCRM (сам
// amoCRM ничего не подписывает), тот же паттерн, что и /api/whatsapp/webhook.
//
// amoCRM шлёт form-urlencoded с ключами вида leads[add][0][id]. По id лида
// добираем через API amoCRM имя лида и телефон контакта — сделка у нас
// заводится сразу с полными данными, наш сервер остаётся мастером истории.
//
// Без timestamp-поля в payload'е amoCRM защита от replay-атак (повторной
// отправки перехваченного запроса) здесь не работает — делать её не из чего.

export async function POST(request: NextRequest) {
  if (isBodyTooLarge(request)) {
    return NextResponse.json({ error: 'Payload Too Large' }, { status: 413 })
  }

  const ip = getClientIp(request)
  const perIp = checkRateLimit(`amocrm-webhook:ip:${ip}`, { windowMs: 60_000, max: 60 })
  if (!perIp.allowed) {
    return NextResponse.json({ error: 'Too Many Requests' }, { status: 429, headers: { 'Retry-After': String(perIp.retryAfterSeconds) } })
  }
  // Общий предохранитель на все IP разом — на случай распределённой атаки.
  const global = checkRateLimit('amocrm-webhook:global', { windowMs: 60_000, max: 300 })
  if (!global.allowed) {
    return NextResponse.json({ error: 'Too Many Requests' }, { status: 429, headers: { 'Retry-After': String(global.retryAfterSeconds) } })
  }

  const secret = request.nextUrl.searchParams.get('secret')
  if (!matchesRotatableSecret(secret, 'AMOCRM_WEBHOOK_SECRET')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Канал выключен (переезд на Green API) — принимаем и молча игнорируем:
  // 200 нужен, чтобы amoCRM не ретраил и не отключил вебхук сам.
  if (process.env.AMOCRM_CHANNEL_ENABLED !== 'true') {
    return NextResponse.json({ ok: true, skipped: 'amocrm channel disabled' })
  }

  const contentType = request.headers.get('content-type') ?? ''
  const raw = await request.text()

  let parsed: Record<string, unknown> = {}
  if (contentType.includes('application/json')) {
    try { parsed = JSON.parse(raw) } catch { parsed = {} }
  } else {
    parsed = Object.fromEntries(new URLSearchParams(raw))
  }

  console.log('amocrm webhook payload', JSON.stringify({ contentType, parsed }).slice(0, 3000))

  const leadIds = extractLeadIds(parsed)
  // Сообщения чатов (вебхук add_message): ответ ИИ занимает секунды, а амо
  // отключает вебхук за таймауты — поэтому 200 сразу, а after() гарантирует,
  // что Next.js не оборвёт фоновую работу после отправки ответа.
  // Исходящие тоже важны: по ним определяем, что в чат вступил живой
  // менеджер — бот такой чат больше не трогает вообще.
  const { incoming, outgoing } = extractChatMessages(parsed)
  after(async () => {
    for (const leadId of leadIds) {
      const details = await fetchLeadDetails(leadId)
      const result = await upsertDealFromInbound({
        externalKey: `amocrm:${leadId}`,
        source: 'amocrm',
        customerName: details?.name ?? null,
        customerPhone: details?.phone ?? null,
      })
      if (result.error) console.error('amocrm webhook deal upsert failed', leadId, result.error)
    }
    // Сначала фиксируем исходящие, чтобы менеджер, ответивший между двумя
    // сообщениями клиента, успел остановить бота до обработки входящего.
    for (const message of outgoing) {
      await registerOutgoingAmoMessage(message).catch((error) =>
        console.error('amocrm outgoing processing failed', message.amoMessageId, error)
      )
    }
    for (const message of incoming) {
      const details = message.leadId ? await fetchLeadDetails(message.leadId) : null
      await processInboundAmoMessage({
        ...message,
        authorName: message.authorName || details?.name || null,
        customerPhone: details?.phone
          || (message.authorName?.match(/^\+?[\d\s()-]{7,}$/) ? message.authorName : null),
      }).catch((error) =>
        console.error('amocrm inbound processing failed', message.amoMessageId, error)
      )
    }
  })

  return NextResponse.json({ ok: true })
}

/** Сообщения из form-ключей message[add][N][...], входящие и исходящие. */
function extractChatMessages(payload: Record<string, unknown>): {
  incoming: import('@/lib/amocrm/bot-reply').InboundAmoMessage[]
  outgoing: import('@/lib/amocrm/bot-reply').InboundAmoMessage[]
} {
  const byIndex = new Map<string, Record<string, string>>()
  for (const [key, value] of Object.entries(payload)) {
    const match = key.match(/^message\[add\]\[(\d+)\]\[([^\]]+)\](?:\[([^\]]+)\])?$/)
    if (!match || typeof value !== 'string') continue
    const [, index, field, subfield] = match
    const bucket = byIndex.get(index) ?? {}
    bucket[subfield ? `${field}.${subfield}` : field] = value
    byIndex.set(index, bucket)
  }
  const incoming: import('@/lib/amocrm/bot-reply').InboundAmoMessage[] = []
  const outgoing: import('@/lib/amocrm/bot-reply').InboundAmoMessage[] = []
  for (const fields of byIndex.values()) {
    if (!fields['id'] || !fields['chat_id']) continue
    // Голосовые/картинки приходят без текста — для детекции менеджера они
    // так же важны, поэтому подставляем плейсхолдер по типу.
    const text = (fields['text'] ?? '').trim() || (fields['message_type'] ? `[${fields['message_type']}]` : '')
    if (!text) continue
    const message = {
      amoMessageId: fields['id'],
      chatId: fields['chat_id'],
      leadId: fields['entity_id'] || fields['element_id'] || null,
      contactId: fields['contact_id'] || null,
      authorName: fields['author.name'] || null,
      text,
      messageType: fields['message_type'] || 'text',
    }
    if (fields['type'] === 'incoming') {
      if ((fields['text'] ?? '').trim() || ['voice', 'audio'].includes(fields['message_type'])) {
        incoming.push(message)
      }
    } else if (fields['type'] === 'outgoing') {
      outgoing.push(message)
    }
  }
  return { incoming, outgoing }
}

/** id лидов из form-urlencoded ключей leads[add][N][id] / leads[status][N][id]. */
function extractLeadIds(payload: Record<string, unknown>): string[] {
  const ids = new Set<string>()
  for (const [key, value] of Object.entries(payload)) {
    if (/^leads\[(add|status)\]\[\d+\]\[id\]$/.test(key) && typeof value === 'string' && value) {
      ids.add(value)
    }
  }
  return [...ids]
}

interface LeadDetails {
  name: string | null
  phone: string | null
}

/**
 * Имя лида + телефон первого привязанного контакта через API amoCRM.
 * Любой сбой не должен ронять приём вебхука — сделка заведётся без
 * обогащения, менеджер дозаполнит руками.
 */
async function fetchLeadDetails(leadId: string): Promise<LeadDetails | null> {
  const domain = process.env.AMOCRM_DOMAIN
  const token = process.env.AMOCRM_ACCESS_TOKEN
  if (!domain || !token) return null
  try {
    const headers = { authorization: `Bearer ${token}` }
    const leadRes = await fetch(`https://${domain}/api/v4/leads/${leadId}?with=contacts`, { headers })
    if (!leadRes.ok) return null
    const lead = await leadRes.json()
    const name: string | null = lead?.name || null

    const contactId = lead?._embedded?.contacts?.[0]?.id
    if (!contactId) return { name, phone: null }

    const contactRes = await fetch(`https://${domain}/api/v4/contacts/${contactId}`, { headers })
    if (!contactRes.ok) return { name, phone: null }
    const contact = await contactRes.json()
    const phoneField = (contact?.custom_fields_values ?? []).find(
      (f: { field_code?: string }) => f?.field_code === 'PHONE'
    )
    const phone: string | null = phoneField?.values?.[0]?.value ?? null
    // Имя контакта информативнее безымянного лида вида «Сделка #123».
    const contactName: string | null = contact?.name || null
    return { name: contactName || name, phone }
  } catch (error) {
    console.error('amocrm lead enrich failed', leadId, error)
    return null
  }
}
