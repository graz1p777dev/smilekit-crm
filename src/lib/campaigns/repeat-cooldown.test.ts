import { describe, expect, it } from 'vitest'
import { REPEAT_COOLDOWN_DAYS, effectiveSkipReachedSince, repeatCooldownSinceIso } from './repeat-cooldown'

const NOW = Date.parse('2026-10-07T07:30:00Z')

describe('правило трёх суток между рассылками', () => {
  it('граница — ровно три суток назад', () => {
    expect(repeatCooldownSinceIso(NOW)).toBe('2026-10-04T07:30:00.000Z')
    expect(REPEAT_COOLDOWN_DAYS).toBe(3)
  })
  it('без запроса из формы всё равно три суток', () => {
    expect(effectiveSkipReachedSince(undefined, NOW)).toBe('2026-10-04T07:30:00.000Z')
  })
  it('более узкую границу из формы правило перекрывает', () => {
    // «только получавшие сегодня» — такой запрос не должен сузить правило
    expect(effectiveSkipReachedSince('2026-10-06T18:00:00.000Z', NOW)).toBe('2026-10-04T07:30:00.000Z')
  })
  it('более широкую границу из формы уважаем', () => {
    expect(effectiveSkipReachedSince('2026-09-30T00:00:00.000Z', NOW)).toBe('2026-09-30T00:00:00.000Z')
  })
})
