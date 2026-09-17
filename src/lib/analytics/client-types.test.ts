import { describe, expect, it } from 'vitest'
import { classifyClient, formatDuration, type ClientFacts } from './client-types'

const T0 = Date.UTC(2026, 8, 17, 6, 0, 0)
const min = (m: number) => T0 + m * 60_000

const bought = (msgsBeforeOrder: number, minutes: number): ClientFacts => ({
  firstDialogAt: T0,
  totalMsgs: msgsBeforeOrder + 3,
  firstOrderAt: min(minutes),
  msgsBeforeOrder,
  humanAfterLastClient: false,
})

const notBought = (totalMsgs: number, humanAfterLastClient: boolean): ClientFacts => ({
  firstDialogAt: T0,
  totalMsgs,
  firstOrderAt: null,
  msgsBeforeOrder: null,
  humanAfterLastClient,
})

describe('classifyClient — купившие', () => {
  it('9 сообщений и 59 минут — железный', () => {
    expect(classifyClient(bought(9, 59))).toBe('iron')
  })
  it('10 сообщений — уже обычный, даже если быстро', () => {
    expect(classifyClient(bought(10, 5))).toBe('regular')
  })
  it('61 минута — обычный, даже если мало сообщений', () => {
    expect(classifyClient(bought(3, 61))).toBe('regular')
  })
  it('ровно 60 минут — не «меньше часа», обычный', () => {
    expect(classifyClient(bought(3, 60))).toBe('regular')
  })
  it('купивший не может быть воздуханом, сколько бы ни было сообщений', () => {
    expect(classifyClient({ ...bought(2, 1), totalMsgs: 4 })).toBe('iron')
  })
})

describe('classifyClient — не купившие', () => {
  it('2 сообщения — «1–2»', () => {
    expect(classifyClient(notBought(2, false))).toBe('short')
    expect(classifyClient(notBought(1, true))).toBe('short')
  })
  it('3 сообщения, менеджер после не писал — воздухан', () => {
    expect(classifyClient(notBought(3, false))).toBe('air')
  })
  it('5 сообщений, менеджер после не писал — воздухан', () => {
    expect(classifyClient(notBought(5, false))).toBe('air')
  })
  it('3–5 сообщений, но человек писал после клиента — не воздухан', () => {
    expect(classifyClient(notBought(3, true))).toBe('midAnswered')
    expect(classifyClient(notBought(5, true))).toBe('midAnswered')
  })
  it('человек писал только ДО последнего сообщения клиента — воздухан', () => {
    // humanAfterLastClient=false описывает именно этот случай.
    expect(classifyClient(notBought(4, false))).toBe('air')
  })
  it('6 сообщений — «6+», независимо от менеджера', () => {
    expect(classifyClient(notBought(6, false))).toBe('long')
    expect(classifyClient(notBought(6, true))).toBe('long')
  })
})

describe('formatDuration', () => {
  it('минуты, часы, дни без округления вверх', () => {
    expect(formatDuration(59.9 * 60_000)).toBe('59 мин')
    expect(formatDuration(190 * 60_000)).toBe('3 ч 10 мин')
    expect(formatDuration(52 * 3600_000)).toBe('2 дн 4 ч')
  })
})
