import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkRateLimit, getClientIp } from './rate-limit.ts'

test('checkRateLimit: разрешает запросы в пределах лимита', () => {
  const key = `test:${Math.random()}`
  for (let i = 0; i < 5; i++) {
    const result = checkRateLimit(key, { windowMs: 60_000, max: 5 })
    assert.equal(result.allowed, true)
  }
})

test('checkRateLimit: блокирует запрос сверх лимита в том же окне', () => {
  const key = `test:${Math.random()}`
  for (let i = 0; i < 3; i++) checkRateLimit(key, { windowMs: 60_000, max: 3 })
  const blocked = checkRateLimit(key, { windowMs: 60_000, max: 3 })
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.retryAfterSeconds >= 1)
})

test('checkRateLimit: разные ключи не влияют друг на друга', () => {
  const keyA = `test:a:${Math.random()}`
  const keyB = `test:b:${Math.random()}`
  for (let i = 0; i < 3; i++) checkRateLimit(keyA, { windowMs: 60_000, max: 3 })
  const resultB = checkRateLimit(keyB, { windowMs: 60_000, max: 3 })
  assert.equal(resultB.allowed, true)
})

test('checkRateLimit: новое окно сбрасывает счётчик', async () => {
  const key = `test:${Math.random()}`
  checkRateLimit(key, { windowMs: 10, max: 1 })
  const blocked = checkRateLimit(key, { windowMs: 10, max: 1 })
  assert.equal(blocked.allowed, false)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const afterWindow = checkRateLimit(key, { windowMs: 10, max: 1 })
  assert.equal(afterWindow.allowed, true)
})

function fakeRequest(forwardedFor: string | null): { headers: { get(name: string): string | null } } {
  return { headers: { get: () => forwardedFor } }
}

test('getClientIp: берёт первый IP из X-Forwarded-For', () => {
  assert.equal(getClientIp(fakeRequest('1.2.3.4, 5.6.7.8')), '1.2.3.4')
})

test('getClientIp: заголовок отсутствует — unknown', () => {
  assert.equal(getClientIp(fakeRequest(null)), 'unknown')
})
