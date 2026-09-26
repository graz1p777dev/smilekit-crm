// Трассировка обязана быть невидимой в проде и полной в отладчике.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTracing, matchedFragment, setTraceSink, trace, type TraceEvent } from './trace'

afterEach(() => setTraceSink(null))

describe('trace — без отладчика ничего не делает', () => {
  it('по умолчанию трассировка выключена', () => {
    expect(isTracing()).toBe(false)
  })

  it('детали не вычисляются, когда приёмника нет — накладных расходов в проде ноль', () => {
    const buildDetails = vi.fn(() => ({ heavy: 'данные' }))
    trace('rule.matched', '996700000000', buildDetails)
    expect(buildDetails).not.toHaveBeenCalled()
  })
})

describe('trace — с включённым отладчиком', () => {
  it('приёмник получает шаг, чат и детали', () => {
    const events: TraceEvent[] = []
    setTraceSink((event) => events.push(event))
    trace('rule.matched', 'lab-cli-1', { rule: 'SCAM_DOUBT', why: 'клиент сомневается' })
    expect(events).toHaveLength(1)
    expect(events[0].step).toBe('rule.matched')
    expect(events[0].chatId).toBe('lab-cli-1')
    expect(events[0].details).toEqual({ rule: 'SCAM_DOUBT', why: 'клиент сомневается' })
    expect(events[0].ts).toBeGreaterThan(0)
  })

  it('ленивые детали вычисляются ровно один раз', () => {
    const buildDetails = vi.fn(() => ({ rule: 'ORDER_INTENT' }))
    setTraceSink(() => {})
    trace('rule.matched', 'lab-cli-1', buildDetails)
    expect(buildDetails).toHaveBeenCalledTimes(1)
  })

  it('упавший приёмник не ломает бота — отладка не имеет права влиять на ответ клиенту', () => {
    setTraceSink(() => {
      throw new Error('окно отладки отвалилось')
    })
    expect(() => trace('outbound', 'lab-cli-1', { text: 'привет' })).not.toThrow()
  })

  it('setTraceSink(null) возвращает полное молчание', () => {
    const sink = vi.fn()
    setTraceSink(sink)
    setTraceSink(null)
    trace('outbound', 'lab-cli-1')
    expect(sink).not.toHaveBeenCalled()
    expect(isTracing()).toBe(false)
  })
})

describe('matchedFragment — «почему сработало правило», а не просто true', () => {
  // [а-яё]*, а не \w*: в JS \w — это ASCII, кириллицу он не захватывает (тот
  // же подвох, из-за которого в bot-reply.ts не используется \b).
  it('отдаёт кусок текста, на котором совпала регулярка', () => {
    expect(matchedFragment(/скидк[а-яё]*/i, 'а скидка будет?')).toBe('скидка')
  })

  it('null, если совпадения нет', () => {
    expect(matchedFragment(/скидк[а-яё]*/i, 'сколько стоит?')).toBeNull()
  })
})
