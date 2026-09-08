// Приём вебхуков Instagram Messaging: проверка подписи, разбор события,
// дедуп по mid, сохранение. Автоответ ИИ сюда сознательно не подключаем —
// пока только приём и сохранение (см. docs/instagram-meta-setup.md и план
// интеграции), автоответ — отдельная задача на будущее.

import { createHmac, timingSafeEqual } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'

/** HMAC-SHA256 по сырому телу с App Secret — заголовок X-Hub-Signature-256: sha256=<hex>. */
export function verifySignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false
  const appSecret = process.env.META_APP_SECRET
  if (!appSecret) return false
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')
  const provided = signatureHeader.slice('sha256='.length)
  const expectedBuf = Buffer.from(expected, 'hex')
  const providedBuf = Buffer.from(provided, 'hex')
  if (expectedBuf.length !== providedBuf.length) return false
  return timingSafeEqual(expectedBuf, providedBuf)
}

interface IncomingMessagingEvent {
  sender: { id: string }
  recipient: { id: string }
  timestamp: number
  message?: { mid: string; text?: string }
}

interface WebhookPayload {
  object?: string
  entry?: { id: string; time: number; messaging?: IncomingMessagingEvent[] }[]
}

export interface ParsedIncomingMessage {
  mid: string
  senderIgsid: string
  text: string
  raw: IncomingMessagingEvent
}

/** Достаёт только настоящие текстовые сообщения от клиента — echo/read/reaction события без `message.mid` пропускаются. */
export function parseIncomingEvents(payload: WebhookPayload): ParsedIncomingMessage[] {
  const result: ParsedIncomingMessage[] = []
  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      if (!event.message?.mid) continue
      result.push({
        mid: event.message.mid,
        senderIgsid: event.sender.id,
        text: event.message.text ?? '',
        raw: event,
      })
    }
  }
  return result
}

/** Upsert с ignoreDuplicates по mid — тот же приём, что sendStageReply в followup-scheduler.ts, чтобы повтор вебхука не создавал дубль строки. Возвращает true, если строка реально новая (стоит передавать дальше в обработку). */
export async function storeInboundMessage(message: ParsedIncomingMessage): Promise<boolean> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('instagram_messages')
    .upsert(
      {
        mid: message.mid,
        sender_igsid: message.senderIgsid,
        direction: 'in',
        text: message.text,
        raw_payload: message.raw,
      },
      { onConflict: 'mid', ignoreDuplicates: true }
    )
    .select('id')
  if (error) {
    console.error('instagram webhook: store inbound message failed', error.message)
    return false
  }
  return Boolean(data?.length)
}

export async function storeOutboundMessage(mid: string, recipientIgsid: string, text: string): Promise<void> {
  const admin = createAdminClient()
  const { error } = await admin.from('instagram_messages').insert({
    mid,
    sender_igsid: recipientIgsid,
    direction: 'out',
    text,
  })
  if (error) console.error('instagram: store outbound message failed', error.message)
}
