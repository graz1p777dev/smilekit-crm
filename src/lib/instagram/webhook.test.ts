import { createHmac } from 'crypto'
import { describe, expect, it, beforeAll } from 'vitest'
import { verifySignature, parseIncomingEvents, parseIncomingComments } from '@/lib/instagram/webhook'

beforeAll(() => {
  process.env.META_APP_SECRET = 'test-app-secret'
})

function sign(body: string): string {
  return `sha256=${createHmac('sha256', 'test-app-secret').update(body, 'utf8').digest('hex')}`
}

describe('verifySignature', () => {
  it('accepts a correctly signed body', () => {
    const body = JSON.stringify({ object: 'instagram' })
    expect(verifySignature(body, sign(body))).toBe(true)
  })

  it('rejects a tampered body', () => {
    const body = JSON.stringify({ object: 'instagram' })
    const signature = sign(body)
    expect(verifySignature(body + 'x', signature)).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(verifySignature('{}', null)).toBe(false)
  })

  it('rejects a header without the sha256= prefix', () => {
    expect(verifySignature('{}', 'deadbeef')).toBe(false)
  })
})

describe('parseIncomingEvents', () => {
  it('extracts text messages and ignores events without a message', () => {
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: 'acct1',
          time: 1,
          messaging: [
            { sender: { id: 'u1' }, recipient: { id: 'acct1' }, timestamp: 1, message: { mid: 'm1', text: 'hi' } },
            { sender: { id: 'u1' }, recipient: { id: 'acct1' }, timestamp: 2 }, // read receipt, no message
          ],
        },
      ],
    }
    const events = parseIncomingEvents(payload)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ mid: 'm1', senderIgsid: 'u1', text: 'hi' })
  })

  it('returns an empty array for a payload with no entries', () => {
    expect(parseIncomingEvents({})).toEqual([])
  })

  it('пропускает эхо собственных исходящих — иначе бот отвечал бы сам себе', () => {
    const payload = {
      entry: [
        {
          id: 'acct1',
          time: 1,
          messaging: [
            { sender: { id: 'acct1' }, recipient: { id: 'u1' }, timestamp: 1, message: { mid: 'm1', text: 'ответ бота', is_echo: true } },
          ],
        },
      ],
    }
    expect(parseIncomingEvents(payload)).toEqual([])
  })

  it('отдаёт время события — по нему считается 24-часовое окно ответа', () => {
    const payload = {
      entry: [
        {
          id: 'acct1',
          time: 1,
          messaging: [{ sender: { id: 'u1' }, recipient: { id: 'acct1' }, timestamp: 1_700_000_000_000, message: { mid: 'm1', text: 'hi' } }],
        },
      ],
    }
    expect(parseIncomingEvents(payload)[0]).toMatchObject({ timestampMs: 1_700_000_000_000, recipientIgsid: 'acct1' })
  })
})

describe('parseIncomingComments', () => {
  const comment = (from: { id: string; username?: string }) => ({
    entry: [
      {
        id: 'acct1',
        time: 1_700_000_000,
        changes: [
          {
            field: 'comments',
            value: { id: 'c1', text: 'Сколько стоит?', media: { id: 'media1' }, from },
          },
        ],
      },
    ],
  })

  it('разбирает комментарий клиента', () => {
    const parsed = parseIncomingComments(comment({ id: 'u1', username: 'client' }))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      commentId: 'c1',
      mediaId: 'media1',
      authorIgsid: 'u1',
      authorUsername: 'client',
      text: 'Сколько стоит?',
      accountId: 'acct1',
    })
    // entry.time приходит в секундах — в мс переводим сами.
    expect(parsed[0].commentedAtMs).toBe(1_700_000_000_000)
  })

  it('игнорирует собственные комментарии аккаунта — иначе бот отвечал бы на свой же ответ', () => {
    expect(parseIncomingComments(comment({ id: 'acct1' }))).toEqual([])
  })

  it('игнорирует changes с другим field', () => {
    const payload = {
      entry: [{ id: 'acct1', time: 1, changes: [{ field: 'mentions', value: { id: 'c1', text: 'x' } }] }],
    }
    expect(parseIncomingComments(payload)).toEqual([])
  })

  it('вебхук сообщений не даёт комментариев и наоборот', () => {
    const messagePayload = {
      entry: [{ id: 'acct1', time: 1, messaging: [{ sender: { id: 'u1' }, recipient: { id: 'acct1' }, timestamp: 1, message: { mid: 'm1', text: 'hi' } }] }],
    }
    expect(parseIncomingComments(messagePayload)).toEqual([])
    expect(parseIncomingEvents(comment({ id: 'u1' }))).toEqual([])
  })
})
