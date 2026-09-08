// Клиент Control Center — телеметрия (heartbeat/usage/events) для внешнего
// дашборда мониторинга. Контракт: docs/CRM_CONNECTOR_CONTRACT.md в репозитории
// ADMINBOT. Никогда не отправляет содержимое сообщений, телефоны или имена —
// только id и числа.
//
// Без CONTROL_CENTER_URL/CONTROL_CENTER_TOKEN весь модуль — no-op: Control
// Center недоступен → CRM работает как раньше. Все вызовы fire-and-forget,
// сетевые ошибки никогда не всплывают в бизнес-логику (только console.warn).

const BASE_URL = process.env.CONTROL_CENTER_URL || ''
const TOKEN = process.env.CONTROL_CENTER_TOKEN || ''
const ENABLED = Boolean(BASE_URL && TOKEN)

if (!ENABLED) {
  console.warn('control-center: CONTROL_CENTER_URL/CONTROL_CENTER_TOKEN не заданы, телеметрия отключена')
}

const TIMEOUT_MS = 5000
const FLUSH_INTERVAL_MS = 60_000
const MAX_BUFFER = 500

async function post(path: string, body: unknown): Promise<void> {
  if (!ENABLED) return
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`control-center: ${path} вернул HTTP ${res.status}`)
    }
  } catch (error) {
    console.warn(`control-center: ${path} не удался`, error)
  }
}

// ─── heartbeat ───────────────────────────────────────────────────────────────

export interface HeartbeatEntry {
  status?: 'ok' | 'degraded' | 'down'
  version?: string
  gitSha?: string
  environment?: string
  deploySource?: 'github' | 'cli' | 'unknown'
  uptimeSeconds?: number
  details?: Record<string, unknown>
  security?: { envPresent: string[] }
}

export function sendHeartbeat(entry: HeartbeatEntry): void {
  void post('/api/v1/connector/heartbeat', entry)
}

// ─── usage / events: батч в памяти, флаш раз в FLUSH_INTERVAL_MS ────────────
// Буфер ограничен MAX_BUFFER (лимит батча API): после заполнения новые записи
// до следующего флаша отбрасываются — не самая свежая запись важна, а то, что
// сама отправка не блокирует и не растит память бесконечно.

export interface UsageEntry {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  costUsd?: number
  occurredAt?: string
  metadata?: Record<string, unknown>
}

export interface EventEntry {
  type: 'lead' | 'deal' | 'order' | 'error'
  level?: 'info' | 'warning' | 'error'
  title: string
  payload?: Record<string, unknown>
  occurredAt?: string
}

const usageBuffer: UsageEntry[] = []
const eventBuffer: EventEntry[] = []

export function recordUsage(entry: UsageEntry): void {
  if (!ENABLED) return
  if (usageBuffer.length >= MAX_BUFFER) return
  usageBuffer.push(entry)
}

export function recordEvent(entry: EventEntry): void {
  if (!ENABLED) return
  if (eventBuffer.length >= MAX_BUFFER) return
  eventBuffer.push(entry)
}

function flushUsage(): void {
  if (!usageBuffer.length) return
  const events = usageBuffer.splice(0, usageBuffer.length)
  void post('/api/v1/connector/usage', { events })
}

function flushEvents(): void {
  if (!eventBuffer.length) return
  const events = eventBuffer.splice(0, eventBuffer.length)
  void post('/api/v1/connector/events', { events })
}

if (ENABLED) {
  const timer = setInterval(() => {
    flushUsage()
    flushEvents()
  }, FLUSH_INTERVAL_MS)
  timer.unref?.()
  // Best-effort: 'exit' не может ждать async fetch, поэтому это не гарантия
  // доставки последнего батча — просто попытка успеть на мягком завершении.
  process.on?.('exit', () => {
    flushUsage()
    flushEvents()
  })
}
