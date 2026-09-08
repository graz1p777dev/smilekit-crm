import { createHmac } from 'crypto'
import { describe, expect, it, beforeAll } from 'vitest'
import { verifySignature, parseIncomingEvents } from '@/lib/instagram/webhook'

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
})
