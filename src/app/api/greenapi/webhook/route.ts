import { NextRequest, NextResponse } from 'next/server'
import { staffPhones } from '@/lib/staff/phones'
import { recordCampaignDeliveryStatus } from '@/lib/campaigns/delivery-status'
import { phoneFromGreenApiChatId } from '@/lib/greenapi/client'
import { processInboundGreenApiMessage, registerOutgoingGreenApiMessage, type InboundGreenApiMessage } from '@/lib/greenapi/bot-reply'
import { isBodyTooLarge, matchesRotatableSecret } from '@/lib/webhook-auth'
import { checkRateLimit, getClientIp } from '@/lib/rate-limit'

// Клиент часто пишет мыслями через несколько сообщений подряд («Здравствуйте»,
// «Хотел узнать», «о товаре») — без этого окна каждое такое сообщение уходило
// в отдельный независимый вызов бота, и клиенту прилетало по несколько
// ответов подряд вместо одного цельного (тот же приём, что в Telegram-боте,
// см. DEBOUNCE_SECONDS в smilekit_bot/__main__.py). Только текстовые
// сообщения без вложений — голосовые/фото обрабатываются сразу, как раньше.
// По просьбе владельца (18.10): бот отвечает сразу. Было 20 с — ждать, пока клиент
// допишет мысль, дольше не нужно; 2 с хватает склеить сообщения, отправленные подряд.
const TEXT_DEBOUNCE_MS = 2_000

interface PendingTextBatch {
  texts: string[]
  latest: Omit<InboundGreenApiMessage, 'text'>
  timer: ReturnType<typeof setTimeout>
}

const pendingTextBatches = new Map<string, PendingTextBatch>()

function flushPendingText(chatId: string): void {
  const pending = pendingTextBatches.get(chatId)
  if (!pending) return
  pendingTextBatches.delete(chatId)
  void processInboundGreenApiMessage({ ...pending.latest, text: pending.texts.join('\n') })
}

function scheduleTextMessage(message: InboundGreenApiMessage): void {
  const existing = pendingTextBatches.get(message.chatId)
  if (existing) clearTimeout(existing.timer)
  const texts = existing ? [...existing.texts, message.text] : [message.text]
  const { text: _text, ...latest } = message
  pendingTextBatches.set(message.chatId, {
    texts,
    latest,
    timer: setTimeout(() => flushPendingText(message.chatId), TEXT_DEBOUNCE_MS),
  })
}

// Green API шлёт Authorization: Bearer <webhookUrlToken> (см. setGreenApiWebhook).
// Без timestamp-поля в payload'е Green API защита от replay-атак здесь не
// работает — делать её не из чего.
const BEARER_PREFIX = 'Bearer '

function isAuthorized(request: NextRequest): boolean {
  const header = request.headers.get('authorization') || ''
  const provided = header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : null
  return matchesRotatableSecret(provided, 'GREENAPI_WEBHOOK_TOKEN')
}

interface GreenApiWebhookBody {
  typeWebhook: string
  idMessage?: string
  /** outgoingMessageStatus: sent | delivered | read | failed | … */
  status?: string
  timestamp?: number
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

  // Живой баг: Green API шлёт вебхук на КАЖДОЕ событие (входящее сообщение,
  // статус отправки, доставки, прочтения) с одного своего IP — 60/мин
  // оказался ниже реального фонового трафика уже при умеренной активности
  // чатов, и часть вебхуков (в т.ч. с входящими сообщениями клиентов)
  // получала 429 и терялась — бот переставал отвечать без единой ошибки в
  // коде. Секрет (isAuthorized) — основная защита, лимит здесь только против
  // явного флуда, поэтому поднимаем с большим запасом, а не убираем совсем.
  const ip = getClientIp(request)
  const perIp = checkRateLimit(`greenapi-webhook:ip:${ip}`, { windowMs: 60_000, max: 1200 })
  if (!perIp.allowed) {
    return NextResponse.json({ error: 'Too Many Requests' }, { status: 429, headers: { 'Retry-After': String(perIp.retryAfterSeconds) } })
  }
  // Общий предохранитель на все IP разом — на случай распределённой атаки.
  const global = checkRateLimit('greenapi-webhook:global', { windowMs: 60_000, max: 3000 })
  if (!global.allowed) {
    return NextResponse.json({ error: 'Too Many Requests' }, { status: 429, headers: { 'Retry-After': String(global.retryAfterSeconds) } })
  }

  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => null)) as GreenApiWebhookBody | null
  if (!body) return NextResponse.json({ error: 'invalid_json' }, { status: 400 })

  // Статус нашего сообщения (доставлено/прочитано) — для отчёта по рассылкам.
  if (body.typeWebhook === 'outgoingMessageStatus') {
    if (body.idMessage) void recordCampaignDeliveryStatus(body.idMessage, body.status, body.timestamp)
      .catch((error) => console.error('greenapi webhook: delivery status failed', error))
    return NextResponse.json({ ok: true })
  }

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
  // Переписка с сотрудником смены (ссылки подтверждения уходят ему с этого
  // номера) — не лид: ни бот, ни аналитика, ни сделки её не касаются.
  if ((await staffPhones()).has(phone)) return NextResponse.json({ ok: true })
  const typeMessage = body.messageData?.typeMessage ?? ''
  const text = extractText(body)
  const authorName = body.senderData?.senderName || body.senderData?.chatName || null

  if (body.typeWebhook === 'incomingMessageReceived') {
    // Голосовые и картинки приходят без текста, но обрабатываются
    // (расшифровка речи и проверка чека) — отбрасываем только то, где нет ни
    // текста, ни файла.
    const hasMedia = Boolean(body.messageData?.fileMessageData?.downloadUrl)
    if (!text && !hasMedia) return NextResponse.json({ ok: true })
    const inbound: InboundGreenApiMessage = {
      providerMessageId,
      chatId: phone,
      authorName,
      text,
      messageType: typeMessage,
      mediaUrl: body.messageData?.fileMessageData?.downloadUrl ?? null,
    }
    if (hasMedia) {
      void processInboundGreenApiMessage(inbound)
    } else {
      scheduleTextMessage(inbound)
    }
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
