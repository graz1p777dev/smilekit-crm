import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/greenapi/bot-reply', () => ({ BULK_BROADCAST_AUTHOR_MARKER: '[система: похоже на массовую рассылку]' }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('./notify', () => ({ notifyTelegram: vi.fn() }))
vi.mock('./service', () => ({ openShifts: vi.fn() }))

const { isReply, waitingChats } = await import('./reminders')

let seq = 0
const msg = (chat: string, sender: string, minute: number, extra: Partial<{ author_name: string; amo_message_id: string }> = {}) => ({
  id: ++seq,
  chat_id: chat,
  sender,
  author_name: extra.author_name ?? null,
  amo_message_id: extra.amo_message_id ?? `ga:${seq}`,
  text: 'текст',
  created_at: new Date(Date.UTC(2026, 8, 17, 10, minute)).toISOString(),
})

describe('isReply', () => {
  it('менеджер — ответ, пометка массовой рассылки — нет', () => {
    expect(isReply(msg('1', 'operator', 0, { author_name: 'Smilekit' }))).toBe(true)
    expect(isReply(msg('1', 'operator', 0, { author_name: '[система: похоже на массовую рассылку]' }))).toBe(false)
  })
  it('бот — ответ, якоря и рассылки — нет', () => {
    expect(isReply(msg('1', 'bot', 0, { amo_message_id: 'ga:bot:abc' }))).toBe(true)
    expect(isReply(msg('1', 'bot', 0, { amo_message_id: 'ga:claim:handed-off:1' }))).toBe(false)
    expect(isReply(msg('1', 'bot', 0, { amo_message_id: 'campaign:1:2' }))).toBe(false)
  })
})

describe('waitingChats', () => {
  it('клиент после ответа менеджера написал снова — ждёт', () => {
    const rows = [msg('a', 'client', 0), msg('a', 'operator', 1, { author_name: 'Smilekit' }), msg('a', 'client', 2)]
    expect(waitingChats(rows).map((m) => m.chat_id)).toEqual(['a'])
  })
  it('ответ после последнего сообщения клиента — не ждёт', () => {
    const rows = [msg('b', 'client', 0), msg('b', 'bot', 1, { amo_message_id: 'ga:bot:x' })]
    expect(waitingChats(rows)).toEqual([])
  })
  it('только служебный якорь после клиента — ждёт', () => {
    const rows = [msg('c', 'client', 0), msg('c', 'bot', 1, { amo_message_id: 'ga:claim:handed-off:1' })]
    expect(waitingChats(rows).map((m) => m.chat_id)).toEqual(['c'])
  })
})
