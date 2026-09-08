// OAuth-флоу «Instagram API with Instagram Login» (Business Login for
// Instagram) — актуальный на август 2026 способ подключения без привязки
// Facebook Page (старый Page-based флоу и scope без префикса `instagram_`
// deprecated с 27.01.2025, см. docs/instagram-meta-setup.md за источниками).
// Версию Graph API (v25.0) и точный набор `fields` в fetchAccountInfo
// сверять с текущей доку при следующем изменении — Meta их периодически
// обновляет.

import { InstagramApiError } from '@/lib/instagram/errors'

const GRAPH_API_VERSION = 'v25.0'
const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize'
const TOKEN_EXCHANGE_URL = 'https://api.instagram.com/oauth/access_token'
const GRAPH_HOST = 'https://graph.instagram.com'

export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'] as const

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} не задан`)
  return value
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv('META_APP_ID'),
    redirect_uri: requireEnv('META_REDIRECT_URI'),
    response_type: 'code',
    scope: INSTAGRAM_SCOPES.join(','),
    state,
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

interface ShortLivedTokenResponse {
  access_token: string
  user_id: string
  permissions?: string[]
}

export async function exchangeCodeForToken(code: string): Promise<ShortLivedTokenResponse> {
  const body = new URLSearchParams({
    client_id: requireEnv('META_APP_ID'),
    client_secret: requireEnv('META_APP_SECRET'),
    grant_type: 'authorization_code',
    redirect_uri: requireEnv('META_REDIRECT_URI'),
    code,
  })
  const response = await fetch(TOKEN_EXCHANGE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    throw new InstagramApiError('INSTAGRAM_AUTH_FAILED', `Instagram code exchange failed: HTTP ${response.status}`)
  }
  return response.json() as Promise<ShortLivedTokenResponse>
}

interface LongLivedTokenResponse {
  access_token: string
  token_type: string
  expires_in: number // секунды, ~60 дней
}

export async function exchangeForLongLivedToken(shortLivedToken: string): Promise<LongLivedTokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: requireEnv('META_APP_SECRET'),
    access_token: shortLivedToken,
  })
  const response = await fetch(`${GRAPH_HOST}/access_token?${params.toString()}`, {
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    throw new InstagramApiError('INSTAGRAM_AUTH_FAILED', `Instagram long-lived token exchange failed: HTTP ${response.status}`)
  }
  return response.json() as Promise<LongLivedTokenResponse>
}

/** Токену должно быть ≥24 часов — вызывающий код (cron/on-demand проверка) сам решает, когда звать. */
export async function refreshLongLivedToken(longLivedToken: string): Promise<LongLivedTokenResponse> {
  const params = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: longLivedToken })
  const response = await fetch(`${GRAPH_HOST}/refresh_access_token?${params.toString()}`, {
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 400 || response.status === 401) {
    throw new InstagramApiError('INSTAGRAM_TOKEN_REVOKED', `Instagram refresh token failed: HTTP ${response.status}`)
  }
  if (!response.ok) {
    throw new InstagramApiError('INSTAGRAM_API_ERROR', `Instagram refresh token failed: HTTP ${response.status}`)
  }
  return response.json() as Promise<LongLivedTokenResponse>
}

interface AccountInfo {
  userId: string
  username: string
}

export async function fetchAccountInfo(accessToken: string): Promise<AccountInfo> {
  const params = new URLSearchParams({ fields: 'user_id,username', access_token: accessToken })
  const response = await fetch(`${GRAPH_HOST}/${GRAPH_API_VERSION}/me?${params.toString()}`, {
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    throw new InstagramApiError('INSTAGRAM_AUTH_FAILED', `Instagram account info failed: HTTP ${response.status}`)
  }
  const data = (await response.json()) as { user_id: string; username: string }
  return { userId: data.user_id, username: data.username }
}

/** Подписка аккаунта на получение вебхуков — отдельный шаг ПОСЛЕ OAuth, без него события не придут даже при верно настроенном App Dashboard. */
export async function subscribeWebhook(igUserId: string, accessToken: string): Promise<void> {
  const params = new URLSearchParams({ subscribed_fields: 'messages', access_token: accessToken })
  const response = await fetch(`${GRAPH_HOST}/${GRAPH_API_VERSION}/${igUserId}/subscribed_apps?${params.toString()}`, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    throw new InstagramApiError('INSTAGRAM_API_ERROR', `Instagram webhook subscribe failed: HTTP ${response.status}`)
  }
}
