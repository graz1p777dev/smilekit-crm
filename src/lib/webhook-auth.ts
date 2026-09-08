// Общие проверки для вебхуков внешних систем (amoCRM, Wazzup, Green API):
// timing-safe сравнение секрета и ограничение размера тела запроса.
// Instagram (src/lib/instagram/webhook.ts) уже делает настоящий HMAC-SHA256
// и timingSafeEqual сам — этот файл его не трогает.

import { createHash, timingSafeEqual } from 'crypto'

/**
 * Сравнение двух строк без утечки через timing attack. Оба значения сначала
 * хешируются SHA-256 — это даёт фиксированную длину (32 байта) для обеих
 * сторон, поэтому timingSafeEqual не бросает исключение при разной длине
 * исходных строк и время сравнения не зависит от того, где нашлось различие.
 */
export function safeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest()
  const hashB = createHash('sha256').update(b).digest()
  return timingSafeEqual(hashA, hashB)
}

/**
 * Проверка входящего общего секрета с поддержкой ротации без простоя
 * (docs/ROTATION.md): значение принимается, если совпадает с process.env[envName]
 * ИЛИ с process.env[envName + '_NEXT'] (когда тот задан и непуст). Оба сравнения
 * timing-safe. Пустое/отсутствующее provided или незаданный env → false.
 */
export function matchesRotatableSecret(provided: string | null | undefined, envName: string): boolean {
  if (!provided) return false
  const current = process.env[envName]
  const next = process.env[`${envName}_NEXT`]
  const matchesCurrent = Boolean(current) && safeEqual(provided, current as string)
  const matchesNext = Boolean(next) && safeEqual(provided, next as string)
  return matchesCurrent || matchesNext
}

/** Больше этого размера тела вебхука быть не должно — все payload'ы маленькие. */
export const MAX_WEBHOOK_BODY_BYTES = 1_000_000

/**
 * Проверка Content-Length до чтения/парсинга тела. Заголовок иногда срезают
 * прокси — тогда просто пропускаем проверку, а не блокируем запрос.
 */
export function isBodyTooLarge(request: { headers: { get(name: string): string | null } }): boolean {
  const contentLength = request.headers.get('content-length')
  if (!contentLength) return false
  const size = Number(contentLength)
  return Number.isFinite(size) && size > MAX_WEBHOOK_BODY_BYTES
}
