import { after, NextRequest, NextResponse } from 'next/server'
import { verifySignature, parseIncomingEvents, storeInboundMessage } from '@/lib/instagram/webhook'

// GET — верификационный хендшейк Meta при настройке Webhooks в App Dashboard
// (hub.mode=subscribe, hub.verify_token, hub.challenge — вернуть challenge
// как есть при совпадении токена). POST — реальные события: подпись
// проверяется по СЫРОМУ телу (до JSON.parse), 200 отдаём сразу, обработка —
// в after() (тот же приём, что /api/amocrm/webhook, гарантирует, что фоновая
// работа не оборвётся после отправки ответа — надёжнее, чем bare `void`,
// который использует /api/greenapi/webhook).

export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get('hub.mode')
  const token = request.nextUrl.searchParams.get('hub.verify_token')
  const challenge = request.nextUrl.searchParams.get('hub.challenge')

  if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN && challenge) {
    return new NextResponse(challenge, { status: 200 })
  }
  return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifySignature(rawBody, signature)) {
    console.error('instagram webhook: invalid signature')
    // 200, а не 403 — иначе Meta считает endpoint нерабочим и может
    // приостановить доставку вебхуков (тот же принцип, что и остальные
    // вебхуки в проекте: подтверждаем приём, ошибку только логируем).
    return NextResponse.json({ ok: true })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ ok: true })
  }

  const events = parseIncomingEvents(payload as Parameters<typeof parseIncomingEvents>[0])
  after(async () => {
    for (const event of events) {
      // Дублирующийся вебхук (Meta ретраит, если не получил 200 вовремя) —
      // storeInboundMessage возвращает false на дубль по mid, дальше не идём.
      await storeInboundMessage(event)
    }
  })

  return NextResponse.json({ ok: true })
}
