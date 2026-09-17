import { describe, expect, it } from 'vitest'
import {
  afterLoginFailure, attemptsLeft, canDecide, isRequestExpired, loginBlockRemainingMs,
  normalizeStaffPhone, planApproval, planShiftStart, validateStaffPassword,
} from './rules'

const NOW = Date.parse('2026-09-17T10:00:00Z')

describe('planShiftStart', () => {
  it('никого нет — смена начинается сразу', () => {
    expect(planShiftStart([], 'a')).toEqual({ type: 'start', mode: 'solo' })
  })
  it('кто-то на смене — нужен запрос', () => {
    expect(planShiftStart(['b'], 'a')).toEqual({ type: 'request', onShiftIds: ['b'] })
  })
  it('уже на смене — ничего не делаем', () => {
    expect(planShiftStart(['a', 'b'], 'a')).toEqual({ type: 'already_on_shift' })
  })
})

describe('planApproval', () => {
  it('«Моя смена» закрывает всех, кто на смене', () => {
    expect(planApproval('take', ['b', 'c'], 'a')).toEqual({ close: ['b', 'c'], startMode: 'solo' })
  })
  it('«Работа вместе» никого не закрывает', () => {
    expect(planApproval('join', ['b'], 'a')).toEqual({ close: [], startMode: 'joint' })
  })
  it('пока ждали, смена закрылась — «вместе» становится обычной сменой', () => {
    expect(planApproval('join', [], 'a')).toEqual({ close: [], startMode: 'solo' })
  })
})

describe('canDecide', () => {
  it('подтверждает тот, кто был на смене', () => {
    expect(canDecide(['b'], 'a', { kind: 'staff', staffId: 'b' })).toBe(true)
  })
  it('сам себе подтвердить нельзя', () => {
    expect(canDecide(['a', 'b'], 'a', { kind: 'staff', staffId: 'a' })).toBe(false)
  })
  it('посторонний сотрудник не подтверждает', () => {
    expect(canDecide(['b'], 'a', { kind: 'staff', staffId: 'c' })).toBe(false)
  })
  it('владелец и ссылка — всегда', () => {
    expect(canDecide(['b'], 'a', { kind: 'owner' })).toBe(true)
    expect(canDecide(['b'], 'a', { kind: 'link' })).toBe(true)
  })
})

describe('вход по паролю', () => {
  it('блок после 5-й ошибки на 5 минут', () => {
    let state = null
    for (let i = 0; i < 4; i++) state = afterLoginFailure(state, NOW)
    expect(state).toEqual({ failures: 4, blockedUntil: null })
    expect(attemptsLeft(state!)).toBe(1)
    state = afterLoginFailure(state, NOW)
    expect(loginBlockRemainingMs(state, NOW)).toBe(5 * 60_000)
    expect(loginBlockRemainingMs(state, NOW + 5 * 60_000)).toBe(0)
  })
  it('после истёкшего блока счёт начинается заново', () => {
    const blocked = { failures: 5, blockedUntil: new Date(NOW - 1).toISOString() }
    expect(afterLoginFailure(blocked, NOW)).toEqual({ failures: 1, blockedUntil: null })
  })
  it('пароль от 3 символов', () => {
    expect(validateStaffPassword('12')).not.toBeNull()
    expect(validateStaffPassword(' 123 ')).toBeNull()
  })
})

it('запрос истекает через 30 минут', () => {
  expect(isRequestExpired(new Date(NOW - 29 * 60_000).toISOString(), NOW)).toBe(false)
  expect(isRequestExpired(new Date(NOW - 30 * 60_000).toISOString(), NOW)).toBe(true)
})

it('телефон приводится к формату чатов WhatsApp', () => {
  expect(normalizeStaffPhone('0700 123 456')).toBe('996700123456')
  expect(normalizeStaffPhone('+996 (700) 12-34-56')).toBe('996700123456')
  expect(normalizeStaffPhone('700123456')).toBe('996700123456')
  expect(normalizeStaffPhone('123')).toBeNull()
})
