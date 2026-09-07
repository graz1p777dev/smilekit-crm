import { NextRequest, NextResponse } from 'next/server'
import { phoneFromGreenApiChatId } from '@/lib/greenapi/client'
import { processInboundGreenApiMessage, registerOutgoingGreenApiMessage } from '@/lib/greenapi/bot-reply'
import { isBodyTooLarge, safeEqual } from '@/lib/webhook-auth'

// Green API шлёт Authorization: Bearer <webhookUrlToken> (см. setGreenApiWebhook).
// Без timestamp-поля в payload'е Green API защита от replay-атак здесь не
// работает — делать её не из чего.
function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.GREENAPI_WEBHOOK_TOKEN
  const header = request.headers.get('authorization') || ''
  return Boolean(expected) && safeEqual(header, `Bearer ${expected}`)
}

interface GreenApiWebhookBody {
  typeWebhook: string
  idMessage?: string
  senderData?: { chatId?: string; sender?: string; senderName?: string; chatName?: string }
  messageData?: {
    typeMessage?: string
    textMessageData?: { textMessage?: string }
    extendedTextMessageData?: { text?: string }
    fileMessageData?: { downloadUrl?: string; caption?: string; mimeType?: string }
  }
}

function extractText(body: GreenApiWebhookBody): string {
  const data = body.messageData
  return (
    data?.textMessageData?.textMessage ??
    data?.extendedTextMessageData?.text ??
    data?.fileMessageData?.caption ??
    ''
  ).trim()
}

export async function POST(request: NextRequest) {
  if (isBodyTooLarge(request)) {
    return NextResponse.json({ error: 'Payload Too Large' }, { status: 413 })
  }
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => null)) as GreenApiWebhookBody | null
  if (!body) return NextResponse.json({ error: 'invalid_json' }, { status: 400 })

  const chatId = body.senderData?.chatId
  const providerMessageId = body.idMessage
  if (!chatId || !providerMessageId) return NextResponse.json({ ok: true }) // служебные события без сообщения

  // Групповые чаты (включая свою же группу доставки, botConfig.deliveryGroupId)
  // никогда не должны доходить до скрипта продаж: chatId группы — это
  // `<id>@g.us`, а phoneFromGreenApiChatId снимает только `@c.us` и пропускает
  // его как есть. Живой баг: сообщение сотрудника в группе доставки
  // обрабатывалось как обычный клиент — заводилась фиктивная сделка и бот
  // мог ответить рекламным текстом/чек-листом прямо в служебном чате.
  if (chatId.endsWith('@g.us')) return NextResponse.json({ ok: true })

  const phone = phoneFromGreenApiChatId(chatId)
  const typeMessage = body.messageData?.typeMessage ?? ''
  const text = extractText(body)
  const authorName = body.senderData?.senderName || body.senderData?.chatName || null

  if (body.typeWebhook === 'incomingMessageReceived') {
    // Голосовые и картинки приходят без текста, но обрабатываются
    // (расшифровка речи и проверка чека) — отбрасываем только то, где нет ни
    // текста, ни файла.
    const hasMedia = Boolean(body.messageData?.fileMessageData?.downloadUrl)
    if (!text && !hasMedia) return NextResponse.json({ ok: true })
    void processInboundGreenApiMessage({
      providerMessageId,
      chatId: phone,
      authorName,
      text,
      messageType: typeMessage,
      mediaUrl: body.messageData?.fileMessageData?.downloadUrl ?? null,
    })
  } else if (body.typeWebhook === 'outgoingMessageReceived') {
    // Только сообщения, отправленные с самого телефона — это живой менеджер.
    // outgoingAPIMessageReceived сюда не попадает: через API шлём только мы,
    // и раньше собственное эхо бота (подводка перед фото) записывалось как
    // менеджер — бот замолкал в чате посреди своей же отправки.
    if (text) {
      void registerOutgoingGreenApiMessage({ providerMessageId, chatId: phone, authorName, text })
    }
  }

  return NextResponse.json({ ok: true })
}
