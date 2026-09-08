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
