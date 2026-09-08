// Простой in-memory rate limiter без внешних зависимостей. Достаточно для
// одного инстанса на Railway — переживать перезапуск не обязано.

interface Bucket {
  count: number
  windowStart: number
}

interface RateLimitOptions {
  windowMs: number
  max: number
}

interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds: number
}

const buckets = new Map<string, Bucket>()

// Периодическая чистка старых записей, чтобы Map не росла бесконечно от
// перебора уникальных IP — без фонового таймера, просто раз в N вызовов.
const SWEEP_INTERVAL_CALLS = 500
const STALE_MS = 10 * 60_000
let callsSinceSweep = 0

function sweep(now: number): void {
  callsSinceSweep += 1
  if (callsSinceSweep < SWEEP_INTERVAL_CALLS) return
  callsSinceSweep = 0
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > STALE_MS) buckets.delete(key)
  }
}

/** Фиксированное окно: max запросов на key за windowMs. */
export function checkRateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now()
  sweep(now)

  const bucket = buckets.get(key)
  if (!bucket || now - bucket.windowStart >= opts.windowMs) {
    buckets.set(key, { count: 1, windowStart: now })
    return { allowed: true, retryAfterSeconds: 0 }
  }

  bucket.count += 1
  if (bucket.count > opts.max) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.windowStart + opts.windowMs - now) / 1000))
    return { allowed: false, retryAfterSeconds }
  }
  return { allowed: true, retryAfterSeconds: 0 }
}

/** Первый IP из X-Forwarded-For, либо 'unknown' — тот же ключ для всех, у кого заголовка нет. */
export function getClientIp(request: { headers: { get(name: string): string | null } }): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (!forwarded) return 'unknown'
  return forwarded.split(',')[0]?.trim() || 'unknown'
}
