import { describe, expect, it } from 'vitest'
import { recurringAudienceFilter, recurringPeriodLabel, type RecurringAudienceOptions } from './recurring-filter'

// 19.09.2026 20:00 по Бишкеку.
const NOW = Date.parse('2026-09-19T14:00:00Z')

const rule = (over: Partial<RecurringAudienceOptions>): RecurringAudienceOptions => ({
  audience: 'not_purchased', period_mode: 'days', window_days: 1, from_date: null,
  include_manager_chats: false, skip_reached_today: true, ...over,
})

describe('recurringAudienceFilter', () => {
  it('сегодняшние — сутки по Бишкеку', () => {
    expect(recurringAudienceFilter(rule({}), NOW, null)).toMatchObject({ from: '2026-09-19', to: '2026-09-19' })
  })
  it('3 дня включают сегодня', () => {
    expect(recurringAudienceFilter(rule({ window_days: 3 }), NOW, null)).toMatchObject({ from: '2026-09-17' })
  })
  it('без ограничения — без дат', () => {
    const f = recurringAudienceFilter(rule({ window_days: null }), NOW, null)
    expect(f?.from).toBeUndefined()
    expect(f?.to).toBeUndefined()
  })
  it('24 часа — точный момент', () => {
    expect(recurringAudienceFilter(rule({ period_mode: 'hours24' }), NOW, null)?.from).toBe('2026-09-18T14:00:00.000Z')
  })
  it('с прошлой рассылки — от её создания; без рассылок — пропуск', () => {
    expect(recurringAudienceFilter(rule({ period_mode: 'since_last' }), NOW, '2026-09-18T13:00:00Z')?.from).toBe('2026-09-18T13:00:00Z')
    expect(recurringAudienceFilter(rule({ period_mode: 'since_last' }), NOW, null)).toBeNull()
  })
  it('с даты — по сегодня', () => {
    expect(recurringAudienceFilter(rule({ period_mode: 'from_date', from_date: '2026-09-01' }), NOW, null))
      .toMatchObject({ from: '2026-09-01', to: '2026-09-19' })
  })
  it('галочки передаются', () => {
    const f = recurringAudienceFilter(rule({ include_manager_chats: true, skip_reached_today: false }), NOW, null)
    expect(f).toMatchObject({ includeManagerChats: true, skipReachedSince: undefined })
    expect(recurringAudienceFilter(rule({}), NOW, null)?.skipReachedSince).toBe('2026-09-18T18:00:00.000Z')
  })
})

it('подписи периода', () => {
  expect(recurringPeriodLabel({ period_mode: 'from_date', window_days: null, from_date: '2026-09-01' })).toBe('писали с 01.09.2026')
  expect(recurringPeriodLabel({ period_mode: 'days', window_days: 1, from_date: null })).toBe('только сегодняшние')
})
