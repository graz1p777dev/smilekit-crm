// Шифрование Instagram access token перед записью в integrations.config.
// Готового crypto-утила в проекте не было (проверено) — пишем минимально:
// AES-256-GCM, ключ из META_TOKEN_ENCRYPTION_KEY (32 байта, base64,
// `openssl rand -base64 32`). Формат хранения: `<iv>:<authTag>:<ciphertext>`,
// всё в base64 — один текстовый столбец, без отдельной таблицы под IV.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12

function getKey(): Buffer {
  const raw = process.env.META_TOKEN_ENCRYPTION_KEY
  if (!raw) throw new Error('META_TOKEN_ENCRYPTION_KEY не задан')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('META_TOKEN_ENCRYPTION_KEY должен быть 32 байта в base64 (openssl rand -base64 32)')
  }
  return key
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`
}

export function decryptToken(stored: string): string {
  const [ivB64, authTagB64, cipherB64] = stored.split(':')
  if (!ivB64 || !authTagB64 || !cipherB64) throw new Error('Некорректный формат зашифрованного токена')
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'))
  const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherB64, 'base64')), decipher.final()])
  return decrypted.toString('utf8')
}
