import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest'
import { buildAuthorizeUrl, exchangeCodeForToken, refreshLongLivedToken } from '@/lib/instagram/oauth'
import { InstagramApiError } from '@/lib/instagram/errors'

beforeAll(() => {
  process.env.META_APP_ID = 'app123'
  process.env.META_APP_SECRET = 'secret123'
  process.env.META_REDIRECT_URI = 'https://example.com/api/instagram/callback'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildAuthorizeUrl', () => {
  it('includes client_id, redirect_uri, messaging scopes and state', () => {
    const url = new URL(buildAuthorizeUrl('state-abc'))
    expect(url.origin + url.pathname).toBe('https://www.instagram.com/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('app123')
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/api/instagram/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toContain('instagram_business_manage_messages')
    expect(url.searchParams.get('state')).toBe('state-abc')
  })
})

describe('exchangeCodeForToken', () => {
  it('throws INSTAGRAM_AUTH_FAILED on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 400 })))
    await expect(exchangeCodeForToken('bad-code')).rejects.toMatchObject({ code: 'INSTAGRAM_AUTH_FAILED' })
  })

  it('returns the parsed token on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: 'short', user_id: 'u1' }), { status: 200 }))
    )
    const result = await exchangeCodeForToken('good-code')
    expect(result.access_token).toBe('short')
  })
})

describe('refreshLongLivedToken', () => {
  it('throws INSTAGRAM_TOKEN_REVOKED on 400/401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    await expect(refreshLongLivedToken('old-token')).rejects.toMatchObject({ code: 'INSTAGRAM_TOKEN_REVOKED' })
  })

  it('throws INSTAGRAM_API_ERROR on other failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })))
    await expect(refreshLongLivedToken('old-token')).rejects.toBeInstanceOf(InstagramApiError)
  })
})
