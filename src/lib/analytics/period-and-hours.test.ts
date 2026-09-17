import { describe, expect, it } from 'vitest'
import { resolvePeriod } from './period'
import { computeStaffHours } from './shift-hours'

// 17.09.2026 01:30 по Бишкеку = 16.09 19:30 UTC.
const NOW = Date.parse('2026-09-16T19:30:00Z')

describe('resolvePeriod — дни по Бишкеку целиком', () => {
  it('сегодня после полуночи по Бишкеку — уже 17-е', () => {
    expect(resolvePeriod({ kind: 'today' }, NOW)).toEqual({
      fromIso: '2026-09-16T18:00:00.000Z', toIso: '2026-09-17T18:00:00.000Z',
      firstDay: '2026-09-17', lastDay: '2026-09-17',
    })
  })
  it('вчера, 7 дней, этот месяц', () => {
    expect(resolvePeriod({ kind: 'yesterday' }, NOW).firstDay).toBe('2026-09-16')
    expect(resolvePeriod({ kind: '7d' }, NOW).firstDay).toBe('2026-09-11')
    expect(resolvePeriod({ kind: '30d' }, NOW).firstDay).toBe('2026-08-19')
    expect(resolvePeriod({ kind: 'month' }, NOW).fromIso).toBe('2026-08-31T18:00:00.000Z')
  })
  it('свои даты — проверка порядка', () => {
    expect(() => resolvePeriod({ kind: 'custom', from: '2026-09-10', to: '2026-09-01' }, NOW)).toThrow()
    expect(resolvePeriod({ kind: 'custom', from: '2026-09-01', to: '2026-09-02' }, NOW).toIso)
      .toBe('2026-09-02T18:00:00.000Z')
  })
})

describe('computeStaffHours', () => {
  const h = (n: number) => Date.parse('2026-09-17T00:00:00Z') + n * 3600_000
  it('вместе — пересечение, засчитывается обоим', () => {
    const res = computeStaffHours([
      { staffId: 'a', name: 'А', from: h(0), to: h(8) },
      { staffId: 'b', name: 'Б', from: h(6), to: h(10) },
    ])
    const a = res.find((r) => r.staffId === 'a')
    const b = res.find((r) => r.staffId === 'b')
    expect(a?.totalMs).toBe(8 * 3600_000)
    expect(a?.togetherMs).toBe(2 * 3600_000)
    expect(b?.togetherMs).toBe(2 * 3600_000)
    expect(a?.withWhom).toEqual([{ staffId: 'b', name: 'Б', ms: 2 * 3600_000 }])
  })
  it('с двумя сразу — «вместе» не удваивается', () => {
    const res = computeStaffHours([
      { staffId: 'a', name: 'А', from: h(0), to: h(4) },
      { staffId: 'b', name: 'Б', from: h(1), to: h(3) },
      { staffId: 'c', name: 'В', from: h(1), to: h(3) },
    ])
    expect(res.find((r) => r.staffId === 'a')?.togetherMs).toBe(2 * 3600_000)
  })
})
