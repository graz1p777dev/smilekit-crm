// Профиль подключения Instagram — строка 'Instagram' в таблице integrations
// (см. supabase/migrations/20260831144639_instagram_messages.sql), тот же
// singleton-паттерн, что src/lib/greenapi/config.ts для WhatsApp, только
// через integrations.config, а не settings.extra — интеграция и так одна
// строка на всю компанию, без organizationId (single-tenant CRM).

import { createAdminClient } from '@/lib/supabase/admin'
import { encryptToken, decryptToken } from '@/lib/instagram/crypto'

export type InstagramConnectionStatus = 'not_connected' | 'connected' | 'error' | 'reauth_required'

export interface InstagramIntegration {
  status: InstagramConnectionStatus
  instagramAccountId: string | null
  username: string | null
  scopes: string[]
  connectedAt: string | null
  lastError: string | null
  bot: InstagramBotSettings
}

/**
 * Переключатели автоответа. Оба по умолчанию выключены: сразу после
 * подключения аккаунта ни одно сообщение не должно уйти клиенту без ведома
 * владельца — он включает канал сам в Настройки → Instagram.
 */
export interface InstagramBotSettings {
  dmEnabled: boolean
  commentsEnabled: boolean
}

export const DEFAULT_INSTAGRAM_BOT_SETTINGS: InstagramBotSettings = { dmEnabled: false, commentsEnabled: false }

interface StoredConfig {
  accessTokenEncrypted?: string
  tokenExpiresAt?: string
  instagramAccountId?: string
  username?: string
  scopes?: string[]
  connectedAt?: string
  status?: InstagramConnectionStatus
  lastError?: string | null
  botDmEnabled?: boolean
  botCommentsEnabled?: boolean
}

function botSettingsOf(config: StoredConfig | null | undefined): InstagramBotSettings {
  return {
    dmEnabled: config?.botDmEnabled === true,
    commentsEnabled: config?.botCommentsEnabled === true,
  }
}

const INTEGRATION_NAME = 'Instagram'

async function loadRow(): Promise<{ id: string; is_active: boolean; config: StoredConfig | null; last_sync_error: string | null } | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('integrations')
    .select('id, is_active, config, last_sync_error')
    .eq('name', INTEGRATION_NAME)
    .maybeSingle()
  return data as { id: string; is_active: boolean; config: StoredConfig | null; last_sync_error: string | null } | null
}

/** Публичный статус для UI — без токена. */
export async function getInstagramIntegration(): Promise<InstagramIntegration> {
  const row = await loadRow()
  const config = row?.config ?? {}
  return {
    status: row?.is_active ? (config.status ?? 'connected') : 'not_connected',
    instagramAccountId: config.instagramAccountId ?? null,
    username: config.username ?? null,
    scopes: config.scopes ?? [],
    connectedAt: config.connectedAt ?? null,
    lastError: row?.last_sync_error ?? null,
    bot: botSettingsOf(config),
  }
}

/**
 * Только переключатели — без остального профиля, чтобы обработчик вебхука не
 * тянул расшифровку токена ради одной проверки. Аккаунт не подключён →
 * выключено: бот в любом случае ничего отправить не сможет.
 */
export async function getInstagramBotSettings(): Promise<InstagramBotSettings> {
  const row = await loadRow()
  if (!row?.is_active) return DEFAULT_INSTAGRAM_BOT_SETTINGS
  return botSettingsOf(row.config)
}

export async function setInstagramBotSettings(settings: Partial<InstagramBotSettings>): Promise<void> {
  const row = await loadRow()
  if (!row) return
  const config: StoredConfig = { ...(row.config ?? {}) }
  if (settings.dmEnabled !== undefined) config.botDmEnabled = settings.dmEnabled
  if (settings.commentsEnabled !== undefined) config.botCommentsEnabled = settings.commentsEnabled
  const admin = createAdminClient()
  await admin.from('integrations').update({ config }).eq('id', row.id)
}

/** Расшифрованный токен + expiry — только для server-side вызовов Graph API, никогда не отдавать во фронт. */
export async function getInstagramAccessToken(): Promise<{ token: string; expiresAt: string; instagramAccountId: string } | null> {
  const row = await loadRow()
  const config = row?.config
  if (!row?.is_active || !config?.accessTokenEncrypted || !config.instagramAccountId || !config.tokenExpiresAt) return null
  return {
    token: decryptToken(config.accessTokenEncrypted),
    expiresAt: config.tokenExpiresAt,
    instagramAccountId: config.instagramAccountId,
  }
}

export async function saveInstagramIntegration(input: {
  accessToken: string
  tokenExpiresAt: string
  instagramAccountId: string
  username: string
  scopes: string[]
}): Promise<void> {
  const admin = createAdminClient()
  // Переключатели автоответа переживают переподключение: владелец проходит
  // «Подключить» заново ради новых разрешений (например comments), и молча
  // выключать уже работающего бота при этом неправильно.
  const previous = await loadRow()
  const config: StoredConfig = {
    botDmEnabled: previous?.config?.botDmEnabled === true,
    botCommentsEnabled: previous?.config?.botCommentsEnabled === true,
    accessTokenEncrypted: encryptToken(input.accessToken),
    tokenExpiresAt: input.tokenExpiresAt,
    instagramAccountId: input.instagramAccountId,
    username: input.username,
    scopes: input.scopes,
    connectedAt: new Date().toISOString(),
    status: 'connected',
    lastError: null,
  }
  await admin
    .from('integrations')
    .update({ is_active: true, config, last_sync_at: new Date().toISOString(), last_sync_status: 'ok', last_sync_error: null })
    .eq('name', INTEGRATION_NAME)
}

/** После обновления долгоживущего токена — обновить только токен/срок, не трогая остальной профиль. */
export async function updateInstagramToken(accessToken: string, tokenExpiresAt: string): Promise<void> {
  const row = await loadRow()
  if (!row) return
  const config: StoredConfig = { ...(row.config ?? {}), accessTokenEncrypted: encryptToken(accessToken), tokenExpiresAt, status: 'connected', lastError: null }
  const admin = createAdminClient()
  await admin
    .from('integrations')
    .update({ config, last_sync_at: new Date().toISOString(), last_sync_status: 'ok', last_sync_error: null })
    .eq('id', row.id)
}

/** Обновить токен не удалось (revoked/permission denied) — просим владельца переподключить, не молчим об этом. */
export async function markInstagramReauthRequired(reason: string): Promise<void> {
  const row = await loadRow()
  if (!row) return
  const config: StoredConfig = { ...(row.config ?? {}), status: 'reauth_required', lastError: reason }
  const admin = createAdminClient()
  await admin
    .from('integrations')
    .update({ config, last_sync_status: 'error', last_sync_error: reason })
    .eq('id', row.id)
}

export async function disconnectInstagram(): Promise<void> {
  const admin = createAdminClient()
  await admin
    .from('integrations')
    .update({ is_active: false, config: {}, last_sync_status: null, last_sync_error: null })
    .eq('name', INTEGRATION_NAME)
}
