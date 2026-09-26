// Отправка сообщений через официальный Instagram Messaging API.
// Правило Meta: свободный текстовый ответ можно отправить только в течение
// 24 часов после последнего сообщения клиента — если Graph API отклонит
// сообщение по этой причине, это придёт как INSTAGRAM_API_ERROR (Meta не
// выделяет отдельный код под окно в 24 часа в теле ошибки), разбираться по
// тексту ответа при необходимости уточнить отдельно.

import { getInstagramAccessToken } from '@/lib/instagram/config'
import { InstagramApiError, type InstagramErrorCode } from '@/lib/instagram/errors'

const GRAPH_API_VERSION = 'v25.0'
const GRAPH_HOST = 'https://graph.instagram.com'

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number }
}

function classifyGraphError(status: number, body: GraphErrorBody): InstagramErrorCode {
  if (status === 429) return 'INSTAGRAM_RATE_LIMIT'
  const code = body.error?.code
  // 190 — invalid/expired OAuth token (истёк или отозван); различаем по
  // error_subcode, где Meta это разделяет, иначе считаем истёкшим.
  if (code === 190) {
    return body.error?.error_subcode === 460 ? 'INSTAGRAM_TOKEN_REVOKED' : 'INSTAGRAM_TOKEN_EXPIRED'
  }
  if (code === 10 || code === 200) return 'INSTAGRAM_PERMISSION_DENIED'
  return 'INSTAGRAM_API_ERROR'
}

export interface SendInstagramMessageInput {
  recipientId: string
  text: string
}

export interface SendInstagramMessageResult {
  recipientId: string
  messageId: string
}

export async function sendInstagramMessage(input: SendInstagramMessageInput): Promise<SendInstagramMessageResult> {
  const account = await getInstagramAccessToken()
  if (!account) throw new InstagramApiError('INSTAGRAM_NOT_CONNECTED', 'Instagram не подключён')

  const response = await fetch(`${GRAPH_HOST}/${GRAPH_API_VERSION}/${account.instagramAccountId}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${account.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ recipient: { id: input.recipientId }, message: { text: input.text } }),
    signal: AbortSignal.timeout(20_000),
  })

  const body = (await response.json().catch(() => ({}))) as GraphErrorBody & { recipient_id?: string; message_id?: string }

  if (!response.ok) {
    const code = classifyGraphError(response.status, body)
    // Не логируем токен — только код/сообщение ошибки Graph API.
    console.error('instagram messaging: send failed', code, body.error?.message ?? `HTTP ${response.status}`)
    throw new InstagramApiError(code, body.error?.message ?? `Instagram send failed: HTTP ${response.status}`)
  }

  if (!body.recipient_id || !body.message_id) {
    throw new InstagramApiError('INSTAGRAM_API_ERROR', 'Instagram send: unexpected response shape')
  }
  return { recipientId: body.recipient_id, messageId: body.message_id }
}

/**
 * Публичный ответ на комментарий под постом — POST /{ig-comment-id}/replies.
 * Требует разрешения instagram_business_manage_comments: если владелец
 * подключил аккаунт до того, как оно появилось в INSTAGRAM_SCOPES, Graph API
 * ответит кодом 10/200 → INSTAGRAM_PERMISSION_DENIED, и нужно переподключение.
 */
export async function replyToInstagramComment(commentId: string, text: string): Promise<string> {
  const account = await getInstagramAccessToken()
  if (!account) throw new InstagramApiError('INSTAGRAM_NOT_CONNECTED', 'Instagram не подключён')

  const response = await fetch(`${GRAPH_HOST}/${GRAPH_API_VERSION}/${commentId}/replies`, {
    method: 'POST',
    headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: text }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await response.json().catch(() => ({}))) as GraphErrorBody & { id?: string }
  if (!response.ok) {
    const code = classifyGraphError(response.status, body)
    console.error('instagram comments: reply failed', code, body.error?.message ?? `HTTP ${response.status}`)
    throw new InstagramApiError(code, body.error?.message ?? `Instagram comment reply failed: HTTP ${response.status}`)
  }
  if (!body.id) throw new InstagramApiError('INSTAGRAM_API_ERROR', 'Instagram comment reply: unexpected response shape')
  return body.id
}

/**
 * «Private reply» — сообщение в директ автору комментария. Отличается от
 * обычного сообщения только адресатом: recipient.comment_id вместо
 * recipient.id (igsid автора комментария нам в вебхуке не обещан). Meta
 * разрешает такой ответ ровно один раз на комментарий — повтор вернёт
 * ошибку, поэтому вызывающий код помечает факт отправки в БД.
 */
export async function sendInstagramPrivateReply(commentId: string, text: string): Promise<string> {
  const account = await getInstagramAccessToken()
  if (!account) throw new InstagramApiError('INSTAGRAM_NOT_CONNECTED', 'Instagram не подключён')

  const response = await fetch(`${GRAPH_HOST}/${GRAPH_API_VERSION}/${account.instagramAccountId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await response.json().catch(() => ({}))) as GraphErrorBody & { message_id?: string }
  if (!response.ok) {
    const code = classifyGraphError(response.status, body)
    console.error('instagram comments: private reply failed', code, body.error?.message ?? `HTTP ${response.status}`)
    throw new InstagramApiError(code, body.error?.message ?? `Instagram private reply failed: HTTP ${response.status}`)
  }
  if (!body.message_id) throw new InstagramApiError('INSTAGRAM_API_ERROR', 'Instagram private reply: unexpected response shape')
  return body.message_id
}

export interface InstagramUserProfile {
  name: string | null
  username: string | null
}

/**
 * Имя/ник клиента по его igsid — нужно, чтобы в списке сделок был человек, а
 * не 17-значный id. Best-effort: Graph API отдаёт профиль не всегда (клиент
 * мог запретить), и без него всё остальное должно работать — поэтому здесь
 * null вместо исключения.
 */
export async function fetchInstagramUserProfile(igsid: string): Promise<InstagramUserProfile | null> {
  const account = await getInstagramAccessToken()
  if (!account) return null
  try {
    const params = new URLSearchParams({ fields: 'name,username', access_token: account.token })
    const response = await fetch(`${GRAPH_HOST}/${GRAPH_API_VERSION}/${igsid}?${params.toString()}`, {
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { name?: string; username?: string }
    return { name: body.name ?? null, username: body.username ?? null }
  } catch (error) {
    console.error('instagram: fetch user profile failed', error)
    return null
  }
}
