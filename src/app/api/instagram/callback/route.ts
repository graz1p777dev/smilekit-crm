import { NextRequest, NextResponse } from 'next/server'
import {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchAccountInfo,
  subscribeWebhook,
  INSTAGRAM_SCOPES,
} from '@/lib/instagram/oauth'
import { saveInstagramIntegration } from '@/lib/instagram/config'
import { InstagramApiError } from '@/lib/instagram/errors'

const STATE_COOKIE = 'ig_oauth_state'
const SETTINGS_PATH = '/dashboard/settings?tab=instagram'

// Шаг 2 OAuth: Meta редиректит сюда с `code`+`state`. `state` сверяется с
// httpOnly cookie из /connect (CSRF), затем code → короткий токен →
// долгоживущий (60 дней) → данные аккаунта → подписка на вебхуки → запись
// профиля в integrations. Ошибки не палят пользователю технические детали
// Graph API — только код ошибки в query редиректа, страница настроек сама
// показывает человеческий текст (humanInstagramError).

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')
  const cookieState = request.cookies.get(STATE_COOKIE)?.value

  const redirectWithError = (errorCode: string) => {
    const url = new URL(SETTINGS_PATH, request.nextUrl.origin)
    url.searchParams.set('error', errorCode)
    const response = NextResponse.redirect(url)
    response.cookies.delete(STATE_COOKIE)
    return response
  }

  if (!code || !state || !cookieState || state !== cookieState) {
    return redirectWithError('INSTAGRAM_AUTH_FAILED')
  }

  try {
    const shortLived = await exchangeCodeForToken(code)
    const longLived = await exchangeForLongLivedToken(shortLived.access_token)
    const account = await fetchAccountInfo(longLived.access_token)
    await subscribeWebhook(account.userId, longLived.access_token)

    const expiresAt = new Date(Date.now() + longLived.expires_in * 1000).toISOString()
    await saveInstagramIntegration({
      accessToken: longLived.access_token,
      tokenExpiresAt: expiresAt,
      instagramAccountId: account.userId,
      username: account.username,
      scopes: shortLived.permissions ?? [...INSTAGRAM_SCOPES],
    })

    const url = new URL(SETTINGS_PATH, request.nextUrl.origin)
    url.searchParams.set('connected', '1')
    const response = NextResponse.redirect(url)
    response.cookies.delete(STATE_COOKIE)
    return response
  } catch (error) {
    const errorCode = error instanceof InstagramApiError ? error.code : 'INSTAGRAM_API_ERROR'
    console.error('instagram oauth callback failed', errorCode, error instanceof Error ? error.message : error)
    return redirectWithError(errorCode)
  }
}
