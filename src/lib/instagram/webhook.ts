// Приём вебхуков Instagram: проверка подписи, разбор события, дедуп по mid /
// id комментария, сохранение. Сам автоответ — в dm-bot.ts и comments.ts,
// здесь только разбор и запись (см. docs/instagram-meta-setup.md).

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
  message?: { mid: string; text?: string; is_echo?: boolean }
}

interface IncomingCommentChange {
  field?: string
  value?: {
    id?: string
    text?: string
    media?: { id?: string }
    from?: { id?: string; username?: string }
    parent_id?: string
    parent?: { id?: string }
  }
}

interface WebhookPayload {
  object?: string
  entry?: {
    id: string
    time: number
    messaging?: IncomingMessagingEvent[]
    changes?: IncomingCommentChange[]
  }[]
}

export interface ParsedIncomingMessage {
  mid: string
  senderIgsid: string
  /** Наш собственный аккаунт (recipient) — нужен, чтобы отличить echo своих же сообщений. */
  recipientIgsid: string
  text: string
  /** Время события от Meta, мс. По нему считается 24-часовое окно ответа. */
  timestampMs: number
  raw: IncomingMessagingEvent
}

/**
 * Достаёт только настоящие текстовые сообщения от клиента — echo/read/reaction
 * события без `message.mid` пропускаются, как и эхо наших же исходящих
 * (`is_echo`), иначе бот отвечал бы сам себе.
 */
export function parseIncomingEvents(payload: WebhookPayload): ParsedIncomingMessage[] {
  const result: ParsedIncomingMessage[] = []
  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      if (!event.message?.mid) continue
      if (event.message.is_echo) continue
      if (event.sender.id === event.recipient.id) continue
      result.push({
        mid: event.message.mid,
        senderIgsid: event.sender.id,
        recipientIgsid: event.recipient.id,
        text: event.message.text ?? '',
        timestampMs: event.timestamp,
        raw: event,
      })
    }
  }
  return result
}

export interface ParsedIncomingComment {
  commentId: string
  mediaId: string | null
  parentCommentId: string | null
  authorIgsid: string | null
  authorUsername: string | null
  text: string
  /** id аккаунта, под постом которого оставлен комментарий (entry.id). */
  accountId: string
  commentedAtMs: number
}

/**
 * Комментарии приходят не в `messaging`, а в `entry[].changes[]` с
 * `field='comments'`. Свои собственные комментарии (и ответы бота на чужие)
 * Meta присылает тем же вебхуком — отсекаем их по `from.id === entry.id`,
 * иначе бот отвечал бы на собственный ответ бесконечно.
 */
export function parseIncomingComments(payload: WebhookPayload): ParsedIncomingComment[] {
  const result: ParsedIncomingComment[] = []
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'comments') continue
      const value = change.value
      if (!value?.id) continue
      if (value.from?.id && value.from.id === entry.id) continue
      result.push({
        commentId: value.id,
        mediaId: value.media?.id ?? null,
        parentCommentId: value.parent_id ?? value.parent?.id ?? null,
        authorIgsid: value.from?.id ?? null,
        authorUsername: value.from?.username ?? null,
        text: value.text ?? '',
        accountId: entry.id,
        commentedAtMs: entry.time > 1e12 ? entry.time : entry.time * 1000,
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
        sender: 'client',
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

export type OutboundStatus = 'sent' | 'window_closed' | 'failed'

/** Исходящее в тот же журнал: и реально отправленное, и «не отправили, окно 24 часа закрыто». */
export async function storeOutboundMessage(input: {
  mid: string
  recipientIgsid: string
  text: string
  status: OutboundStatus
  sender?: 'bot' | 'operator'
}): Promise<void> {
  const admin = createAdminClient()
  const { error } = await admin.from('instagram_messages').upsert(
    {
      mid: input.mid,
      sender_igsid: input.recipientIgsid,
      direction: 'out',
      sender: input.sender ?? 'bot',
      text: input.text,
      status: input.status,
    },
    { onConflict: 'mid', ignoreDuplicates: true }
  )
  if (error) console.error('instagram: store outbound message failed', error.message)
}

/**
 * Захват комментария: вставка с ignoreDuplicates по UNIQUE(comment_id).
 * true — комментарий новый и его можно обрабатывать, false — вебхук уже
 * приходил (Meta ретраит), второй ответ слать нельзя.
 */
export async function claimComment(comment: ParsedIncomingComment): Promise<boolean> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('instagram_comments')
    .upsert(
      {
        comment_id: comment.commentId,
        media_id: comment.mediaId,
        parent_comment_id: comment.parentCommentId,
        author_igsid: comment.authorIgsid,
        author_username: comment.authorUsername,
        text: comment.text,
        commented_at: new Date(comment.commentedAtMs).toISOString(),
        status: 'received',
      },
      { onConflict: 'comment_id', ignoreDuplicates: true }
    )
    .select('id')
  if (error) {
    console.error('instagram webhook: store comment failed', error.message)
    return false
  }
  return Boolean(data?.length)
}

export async function markCommentReplied(
  commentId: string,
  update: { replyText?: string; privateReplySent?: boolean; status: 'replied' | 'failed'; error?: string | null }
): Promise<void> {
  const admin = createAdminClient()
  const { error } = await admin
    .from('instagram_comments')
    .update({
      reply_text: update.replyText ?? null,
      private_reply_sent: update.privateReplySent ?? false,
      status: update.status,
      error: update.error ?? null,
    })
    .eq('comment_id', commentId)
  if (error) console.error('instagram: mark comment replied failed', error.message)
}
