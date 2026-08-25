// ─── POST /api/internal/orders/notify-shipped ───────────────────────────────
// Telegram-бот зовёт этот эндпоинт для WhatsApp-заказов (Telegram-заказы бот
// уведомляет сам, напрямую), когда курьер в группе доставки ответил «Взял»
// на сообщение с заказом (см. message-обработчик в __main__.py). Клиенту
// уходит благодарность, инструкция по применению и ссылка на Telegram-бота
// с программой ухода. Тот же общий секрет, что у остальных /api/internal/*.

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendGreenApiMessage, sendGreenApiFileByUrl, toGreenApiChatId } from '@/lib/greenapi/client'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const THANK_YOU_TEXT = 'Спасибо за покупку! 🎉 Заказ уже у курьера — скоро будет у вас.'
const USAGE_INSTRUCTIONS =
  '1. Высушите зубы, отклейте полоски и плотно нанесите их на верхние и нижние зубы.\n' +
  '2. Засеките 30 минут.\n' +
  '3. Старайтесь держать рот открытым, чтобы не скапливалась влага.\n' +
  '4. Снимите прозрачную плёнку, удалите отбеливатель салфеткой и смойте остатки.'
const TELEGRAM_APP_TEXT =
  'Кстати, у нас есть Telegram-бот с программой ухода специально для тех, кто уже купил наши полоски — ' +
  'напоминания, советы по уходу и ИИ-консультант. Откройте: https://t.me/Smilekitkgbot'

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
  const { data: order } = await supabase
    .from('orders')
    .select('customer_phone')
    .eq('external_key', externalKey)
    .maybeSingle()
  const phone = (order as { customer_phone: string | null } | null)?.customer_phone
  if (!phone) return NextResponse.json({ ok: true, skipped: 'no_phone' })

  const chatId = toGreenApiChatId(phone)
  const mediaBaseUrl = process.env.SMILEKIT_BOT_API_URL?.replace(/\/$/, '')
  try {
    await sendGreenApiMessage(chatId, THANK_YOU_TEXT)
    if (mediaBaseUrl) {
      await sendGreenApiFileByUrl({
        chatId,
        urlFile: `${mediaBaseUrl}/media/results/instructia.jpeg`,
        fileName: 'instructia.jpeg',
        caption: USAGE_INSTRUCTIONS,
      })
    }
    await sendGreenApiMessage(chatId, TELEGRAM_APP_TEXT)
  } catch (error) {
    console.error('internal/orders/notify-shipped: send failed', error)
    return NextResponse.json({ error: 'Send failed' }, { status: 502 })
  }

  return NextResponse.json({ ok: true })
}
