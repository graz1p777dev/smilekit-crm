// Типизированные ошибки Instagram-интеграции — фронту отдаём этот код (и
// человеческий текст рядом), не сырые детали Graph API.

export type InstagramErrorCode =
  | 'INSTAGRAM_NOT_CONNECTED'
  | 'INSTAGRAM_AUTH_FAILED'
  | 'INSTAGRAM_PERMISSION_DENIED'
  | 'INSTAGRAM_TOKEN_EXPIRED'
  | 'INSTAGRAM_TOKEN_REVOKED'
  | 'INSTAGRAM_RATE_LIMIT'
  | 'INSTAGRAM_API_ERROR'
  | 'INSTAGRAM_WEBHOOK_INVALID_SIGNATURE'

export class InstagramApiError extends Error {
  readonly code: InstagramErrorCode

  constructor(code: InstagramErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'InstagramApiError'
  }
}

const HUMAN_MESSAGES: Record<InstagramErrorCode, string> = {
  INSTAGRAM_NOT_CONNECTED: 'Instagram не подключён.',
  INSTAGRAM_AUTH_FAILED: 'Не удалось подтвердить подключение Instagram. Попробуйте ещё раз.',
  INSTAGRAM_PERMISSION_DENIED: 'Instagram не выдал нужные разрешения. Переподключите аккаунт и подтвердите все запрошенные права.',
  INSTAGRAM_TOKEN_EXPIRED: 'Срок действия подключения истёк. Переподключите Instagram.',
  INSTAGRAM_TOKEN_REVOKED: 'Доступ к Instagram был отозван. Переподключите аккаунт.',
  INSTAGRAM_RATE_LIMIT: 'Instagram временно ограничил запросы. Попробуйте позже.',
  INSTAGRAM_API_ERROR: 'Instagram сейчас недоступен. Попробуйте позже.',
  INSTAGRAM_WEBHOOK_INVALID_SIGNATURE: 'Подпись webhook не прошла проверку.',
}

export function humanInstagramError(code: InstagramErrorCode): string {
  return HUMAN_MESSAGES[code]
}
