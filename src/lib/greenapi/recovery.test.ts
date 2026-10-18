import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bot-log', () => ({ logBotEvent: vi.fn() }))
vi.mock('@/lib/greenapi/bot-reply', () => ({ recoverWaChat: vi.fn(), waEngineGate: vi.fn(async () => true) }))
vi.mock('@/lib/greenapi/wa-engine', () => ({ isWaEnginePhone: () => true }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

import { findUnansweredChats } from '@/lib/greenapi/recovery'

function fakeDb(rows: unknown[]) {
  const builder = {
    select: () => builder,
    gte: () => builder,
    order: () => builder,
    range: () => Promise.resolve({ data: rows, error: null }),
  }
  return { from: () => builder } as never
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

describe('findUnansweredChats', () => {
  it('клиент написал, бот и менеджер молчат — чат в списке', async () => {
    const db = fakeDb([{ id: 1, chat_id: '996700000001', direction: 'in', text: 'Сколько стоит?', created_at: ago(30) }])
    const [chat] = await findUnansweredChats(db)
    expect(chat.chatId).toBe('996700000001')
    expect(chat.text).toBe('Сколько стоит?')
  })

  it('после сообщения клиента есть ответ — чата в списке нет', async () => {
    const db = fakeDb([
      { id: 1, chat_id: '996700000001', direction: 'in', text: 'Привет', created_at: ago(30) },
      { id: 2, chat_id: '996700000001', direction: 'out', text: 'Здравствуйте', created_at: ago(29) },
    ])
    expect(await findUnansweredChats(db)).toHaveLength(0)
  })

  it('служебный якорь бота «[ожидание города]» ответом не считается', async () => {
    const db = fakeDb([
      { id: 1, chat_id: '996700000001', direction: 'in', text: 'Привет', created_at: ago(30) },
      { id: 2, chat_id: '996700000001', direction: 'out', text: '[ожидание города]', created_at: ago(29) },
    ])
    expect(await findUnansweredChats(db)).toHaveLength(1)
  })

  it('совсем свежее сообщение (бот ещё думает) не трогаем', async () => {
    const db = fakeDb([{ id: 1, chat_id: '996700000001', direction: 'in', text: 'Привет', created_at: ago(1) }])
    expect(await findUnansweredChats(db)).toHaveLength(0)
  })

  it('несколько сообщений подряд склеиваются, вложение берётся отдельно', async () => {
    const db = fakeDb([
      { id: 1, chat_id: '996700000001', direction: 'in', text: 'Вот чек', created_at: ago(31) },
      { id: 2, chat_id: '996700000001', direction: 'in', text: '\n[media]https://x/y.jpg', created_at: ago(30) },
    ])
    const [chat] = await findUnansweredChats(db)
    expect(chat.messages).toBe(2)
    expect(chat.text).toBe('Вот чек')
    expect(chat.mediaUrl).toBe('https://x/y.jpg')
  })
})
