import { expect, test } from 'vitest'
import { checkRateLimit, getClientIp } from './rate-limit'

test('checkRateLimit: разрешает запросы в пределах лимита', () => {
  const key = `test:${Math.random()}`
  for (let i = 0; i < 5; i++) {
    const result = checkRateLimit(key, { windowMs: 60_000, max: 5 })
    expect(result.allowed).toBe(true)
  }
})

test('checkRateLimit: блокирует запрос сверх лимита в том же окне', () => {
  const key = `test:${Math.random()}`
  for (let i = 0; i < 3; i++) checkRateLimit(key, { windowMs: 60_000, max: 3 })
  const blocked = checkRateLimit(key, { windowMs: 60_000, max: 3 })
  expect(blocked.allowed).toBe(false)
  expect(blocked.retryAfterSeconds >= 1).toBe(true)
})

test('checkRateLimit: разные ключи не влияют друг на друга', () => {
  const keyA = `test:a:${Math.random()}`
  const keyB = `test:b:${Math.random()}`
  for (let i = 0; i < 3; i++) checkRateLimit(keyA, { windowMs: 60_000, max: 3 })
  const resultB = checkRateLimit(keyB, { windowMs: 60_000, max: 3 })
  expect(resultB.allowed).toBe(true)
})

test('checkRateLimit: новое окно сбрасывает счётчик', async () => {
  const key = `test:${Math.random()}`
  checkRateLimit(key, { windowMs: 10, max: 1 })
  const blocked = checkRateLimit(key, { windowMs: 10, max: 1 })
  expect(blocked.allowed).toBe(false)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const afterWindow = checkRateLimit(key, { windowMs: 10, max: 1 })
  expect(afterWindow.allowed).toBe(true)
})

function fakeRequest(forwardedFor: string | null): { headers: { get(name: string): string | null } } {
  return { headers: { get: () => forwardedFor } }
}

test('getClientIp: берёт первый IP из X-Forwarded-For', () => {
  expect(getClientIp(fakeRequest('1.2.3.4, 5.6.7.8'))).toBe('1.2.3.4')
})

test('getClientIp: заголовок отсутствует — unknown', () => {
  expect(getClientIp(fakeRequest(null))).toBe('unknown')
})
