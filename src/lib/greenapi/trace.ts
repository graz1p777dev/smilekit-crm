// Трассировка решений WhatsApp-бота — «почему бот ответил именно так».
//
// В проде приёмника нет (sink === null), и любой вызов trace() выходит на
// первой же строке: детали события считаются ЛЕНИВО (через функцию), поэтому
// ни объект, ни строки для отладки в обычной работе вообще не создаются.
// Приёмник ставит только отладчик (scripts/bot-cli-server.mts) — на время
// своего сеанса, в своём процессе.
//
// Само наблюдение никогда не должно ломать бота: приёмник вызывается в
// try/catch, ошибка отладки проглатывается.

export type TraceDetails = Record<string, unknown>

export interface TraceEvent {
  /** Момент события, мс с эпохи. */
  ts: number
  /** Шаг сценария: 'inbound', 'rule.matched', 'ai.request' и т.п. */
  step: string
  /** Чат, к которому относится событие (если известен). */
  chatId: string | null
  details: TraceDetails
}

export type TraceSink = (event: TraceEvent) => void

let sink: TraceSink | null = null

/** Включить/выключить трассировку. null — вернуть «ничего не делает». */
export function setTraceSink(next: TraceSink | null): void {
  sink = next
}

/** Включена ли трассировка — чтобы не считать тяжёлые детали зря. */
export function isTracing(): boolean {
  return sink !== null
}

/**
 * Записать шаг решения. details — либо готовый объект, либо функция, которая
 * его построит (вызывается только при включённой трассировке).
 */
export function trace(
  step: string,
  chatId: string | null,
  details: TraceDetails | (() => TraceDetails) = {}
): void {
  if (!sink) return
  try {
    sink({
      ts: Date.now(),
      step,
      chatId,
      details: typeof details === 'function' ? details() : details,
    })
  } catch {
    // Отладка не имеет права влиять на ответ клиенту.
  }
}

/** Первое совпадение регулярки — «почему сработало это правило», а не просто true. */
export function matchedFragment(pattern: RegExp, text: string): string | null {
  return text.match(pattern)?.[0] ?? null
}
