import { expect, test } from 'vitest'
import { isBodyTooLarge, MAX_WEBHOOK_BODY_BYTES, safeEqual } from './webhook-auth'

test('safeEqual: равные строки', () => {
  expect(safeEqual('secret123', 'secret123')).toBe(true)
})

test('safeEqual: разные строки одинаковой длины', () => {
  expect(safeEqual('secret123', 'secret124')).toBe(false)
})

test('safeEqual: разная длина не бросает исключение', () => {
  expect(() => safeEqual('short', 'a-much-longer-secret-value')).not.toThrow()
  expect(safeEqual('short', 'a-much-longer-secret-value')).toBe(false)
})

test('safeEqual: пустые строки', () => {
  expect(safeEqual('', '')).toBe(true)
  expect(safeEqual('', 'x')).toBe(false)
})

function fakeRequest(contentLength: string | null): { headers: { get(name: string): string | null } } {
  return { headers: { get: () => contentLength } }
}

test('isBodyTooLarge: заголовок отсутствует — не блокируем', () => {
  expect(isBodyTooLarge(fakeRequest(null))).toBe(false)
})

test('isBodyTooLarge: размер в пределах лимита', () => {
  expect(isBodyTooLarge(fakeRequest(String(MAX_WEBHOOK_BODY_BYTES)))).toBe(false)
})

test('isBodyTooLarge: размер больше лимита', () => {
  expect(isBodyTooLarge(fakeRequest(String(MAX_WEBHOOK_BODY_BYTES + 1)))).toBe(true)
})
