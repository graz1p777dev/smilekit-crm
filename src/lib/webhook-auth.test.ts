import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBodyTooLarge, MAX_WEBHOOK_BODY_BYTES, safeEqual } from './webhook-auth.ts'

test('safeEqual: равные строки', () => {
  assert.equal(safeEqual('secret123', 'secret123'), true)
})

test('safeEqual: разные строки одинаковой длины', () => {
  assert.equal(safeEqual('secret123', 'secret124'), false)
})

test('safeEqual: разная длина не бросает исключение', () => {
  assert.doesNotThrow(() => safeEqual('short', 'a-much-longer-secret-value'))
  assert.equal(safeEqual('short', 'a-much-longer-secret-value'), false)
})

test('safeEqual: пустые строки', () => {
  assert.equal(safeEqual('', ''), true)
  assert.equal(safeEqual('', 'x'), false)
})

function fakeRequest(contentLength: string | null): { headers: { get(name: string): string | null } } {
  return { headers: { get: () => contentLength } }
}

test('isBodyTooLarge: заголовок отсутствует — не блокируем', () => {
  assert.equal(isBodyTooLarge(fakeRequest(null)), false)
})

test('isBodyTooLarge: размер в пределах лимита', () => {
  assert.equal(isBodyTooLarge(fakeRequest(String(MAX_WEBHOOK_BODY_BYTES))), false)
})

test('isBodyTooLarge: размер больше лимита', () => {
  assert.equal(isBodyTooLarge(fakeRequest(String(MAX_WEBHOOK_BODY_BYTES + 1))), true)
})
