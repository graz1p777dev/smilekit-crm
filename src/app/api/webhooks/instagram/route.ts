import { after, NextRequest, NextResponse } from 'next/server'
import { verifySignature, parseIncomingEvents, parseIncomingComments } from '@/lib/instagram/webhook'
import { handleInstagramInboundMessage } from '@/lib/instagram/dm-bot'
import { handleInstagramComment } from '@/lib/instagram/comments'
import { matchesRotatableSecret } from '@/lib/webhook-auth'

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

  if (mode === 'subscribe' && matchesRotatableSecret(token, 'META_WEBHOOK_VERIFY_TOKEN') && challenge) {
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

  // ВРЕМЕННО (10.10, снять после диагностики): тишина без единой ошибки —
  // нужно увидеть реальную форму payload от Meta.
  console.log('instagram webhook raw payload', rawBody.slice(0, 4000))

  const events = parseIncomingEvents(payload as Parameters<typeof parseIncomingEvents>[0])
  const comments = parseIncomingComments(payload as Parameters<typeof parseIncomingComments>[0])
  after(async () => {
    // Дублирующийся вебхук (Meta ретраит, если не получил 200 вовремя)
    // отсекается внутри обработчиков — по mid сообщения и по id комментария.
    // Одна упавшая обработка не должна съесть остальные события пачки.
    for (const event of events) {
      try {
        await handleInstagramInboundMessage(event)
      } catch (error) {
        console.error('instagram webhook: message handling failed', error)
      }
    }
    for (const comment of comments) {
      try {
        await handleInstagramComment(comment)
      } catch (error) {
        console.error('instagram webhook: comment handling failed', error)
      }
    }
  })

  return NextResponse.json({ ok: true })
}
