import { describe, expect, it, beforeAll } from 'vitest'
import { encryptToken, decryptToken } from '@/lib/instagram/crypto'

beforeAll(() => {
  process.env.META_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
})

describe('instagram token encryption', () => {
  it('roundtrips a token through encrypt/decrypt', () => {
    const original = 'IGAAsomeLongAccessTokenValue1234567890'
    const encrypted = encryptToken(original)
    expect(encrypted).not.toBe(original)
    expect(decryptToken(encrypted)).toBe(original)
  })

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptToken('same-token')
    const b = encryptToken('same-token')
    expect(a).not.toBe(b)
  })

  it('throws on a tampered ciphertext', () => {
    const encrypted = encryptToken('token-to-tamper')
    const [iv, tag, cipher] = encrypted.split(':')
    const tampered = `${iv}:${tag}:${cipher.slice(0, -4)}${cipher.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`
    expect(() => decryptToken(tampered)).toThrow()
  })
})
