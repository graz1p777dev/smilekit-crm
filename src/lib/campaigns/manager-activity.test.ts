// Правило владельца 17.09: рассылка не идёт в чат, только если менеджер
// общался там за последние 30 минут. Молчит дольше — чат доступен.
import { describe, expect, it } from 'vitest'
import { isManagerActiveInChat, MANAGER_ACTIVE_WINDOW_MS } from './manager-activity'

const NOW = new Date('2026-09-17T14:00:00Z').getTime()
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

describe('isManagerActiveInChat — окно активности менеджера для рассылок', () => {
  it('окно ровно 30 минут', () => {
    expect(MANAGER_ACTIVE_WINDOW_MS).toBe(30 * 60_000)
  })

  it('менеджер писал 10 минут назад — идёт разговор, рассылку не шлём', () => {
    expect(isManagerActiveInChat(minutesAgo(10), undefined, NOW)).toBe(true)
  })

  it('живой случай 17.09: менеджер писал утром, спустя часы — рассылку шлём', () => {
    expect(isManagerActiveInChat(minutesAgo(5 * 60), undefined, NOW)).toBe(false)
  })

  it('граница: 29 минут — ещё активен, 31 минута — уже нет', () => {
    expect(isManagerActiveInChat(minutesAgo(29), undefined, NOW)).toBe(true)
    expect(isManagerActiveInChat(minutesAgo(31), undefined, NOW)).toBe(false)
  })

  it('менеджер никогда не писал — рассылку шлём', () => {
    expect(isManagerActiveInChat(null, undefined, NOW)).toBe(false)
  })

  it('чат вернули боту после сообщения менеджера — рассылку шлём даже при свежем сообщении', () => {
    expect(isManagerActiveInChat(minutesAgo(10), { bot_enabled: true, updated_at: minutesAgo(5) }, NOW)).toBe(false)
  })

  it('менеджер забрал чат себе только что, не написав ни слова — активен', () => {
    expect(isManagerActiveInChat(null, { bot_enabled: false, updated_at: minutesAgo(3) }, NOW)).toBe(true)
  })

  it('менеджер забрал чат себе давно и молчит — рассылку шлём', () => {
    expect(isManagerActiveInChat(null, { bot_enabled: false, updated_at: minutesAgo(90) }, NOW)).toBe(false)
  })

  it('чат вернули боту, но менеджер снова написал позже — активен', () => {
    expect(isManagerActiveInChat(minutesAgo(5), { bot_enabled: true, updated_at: minutesAgo(20) }, NOW)).toBe(true)
  })
})
