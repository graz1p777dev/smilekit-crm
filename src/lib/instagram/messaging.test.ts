import { describe, expect, it, vi, afterEach } from 'vitest'

vi.mock('@/lib/instagram/config', () => ({
  getInstagramAccessToken: vi.fn(),
}))

import { getInstagramAccessToken } from '@/lib/instagram/config'
import { sendInstagramMessage } from '@/lib/instagram/messaging'

const mockedGetToken = vi.mocked(getInstagramAccessToken)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('sendInstagramMessage', () => {
  it('throws INSTAGRAM_NOT_CONNECTED when there is no active integration', async () => {
    mockedGetToken.mockResolvedValue(null)
    await expect(sendInstagramMessage({ recipientId: 'u1', text: 'hi' })).rejects.toMatchObject({
      code: 'INSTAGRAM_NOT_CONNECTED',
    })
  })

  it('returns recipientId/messageId on success', async () => {
    mockedGetToken.mockResolvedValue({ token: 'tok', expiresAt: new Date().toISOString(), instagramAccountId: 'acct1' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ recipient_id: 'u1', message_id: 'm1' }), { status: 200 }))
    )
    const result = await sendInstagramMessage({ recipientId: 'u1', text: 'hi' })
    expect(result).toEqual({ recipientId: 'u1', messageId: 'm1' })
  })

  it('classifies an expired token (code 190) as INSTAGRAM_TOKEN_EXPIRED', async () => {
    mockedGetToken.mockResolvedValue({ token: 'tok', expiresAt: new Date().toISOString(), instagramAccountId: 'acct1' })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'expired', code: 190 } }), { status: 401 })
      )
    )
    await expect(sendInstagramMessage({ recipientId: 'u1', text: 'hi' })).rejects.toMatchObject({
      code: 'INSTAGRAM_TOKEN_EXPIRED',
    })
  })

  it('classifies HTTP 429 as INSTAGRAM_RATE_LIMIT', async () => {
    mockedGetToken.mockResolvedValue({ token: 'tok', expiresAt: new Date().toISOString(), instagramAccountId: 'acct1' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 429 })))
    await expect(sendInstagramMessage({ recipientId: 'u1', text: 'hi' })).rejects.toMatchObject({
      code: 'INSTAGRAM_RATE_LIMIT',
    })
  })
})
