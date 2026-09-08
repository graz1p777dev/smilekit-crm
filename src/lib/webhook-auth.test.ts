import { afterEach, expect, test, vi } from 'vitest'
import { isBodyTooLarge, matchesRotatableSecret, MAX_WEBHOOK_BODY_BYTES, safeEqual } from './webhook-auth'

afterEach(() => {
  vi.unstubAllEnvs()
})

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

test('matchesRotatableSecret: текущее значение принимается', () => {
  vi.stubEnv('ROT_TEST_SECRET', 'current')
  expect(matchesRotatableSecret('current', 'ROT_TEST_SECRET')).toBe(true)
})

test('matchesRotatableSecret: значение из _NEXT принимается во время ротации', () => {
  vi.stubEnv('ROT_TEST_SECRET', 'current')
  vi.stubEnv('ROT_TEST_SECRET_NEXT', 'next')
  expect(matchesRotatableSecret('next', 'ROT_TEST_SECRET')).toBe(true)
  expect(matchesRotatableSecret('current', 'ROT_TEST_SECRET')).toBe(true)
})

test('matchesRotatableSecret: неверное значение отклоняется', () => {
  vi.stubEnv('ROT_TEST_SECRET', 'current')
  vi.stubEnv('ROT_TEST_SECRET_NEXT', 'next')
  expect(matchesRotatableSecret('wrong', 'ROT_TEST_SECRET')).toBe(false)
})

test('matchesRotatableSecret: пустой или незаданный _NEXT игнорируется', () => {
  vi.stubEnv('ROT_TEST_SECRET', 'current')
  vi.stubEnv('ROT_TEST_SECRET_NEXT', '')
  expect(matchesRotatableSecret('', 'ROT_TEST_SECRET')).toBe(false)
  expect(matchesRotatableSecret('current', 'ROT_TEST_SECRET')).toBe(true)
  vi.unstubAllEnvs()
  vi.stubEnv('ROT_TEST_SECRET', 'current')
  expect(process.env.ROT_TEST_SECRET_NEXT).toBeUndefined()
  expect(matchesRotatableSecret('current', 'ROT_TEST_SECRET')).toBe(true)
})

test('matchesRotatableSecret: пустое/отсутствующее provided отклоняется', () => {
  vi.stubEnv('ROT_TEST_SECRET', 'current')
  expect(matchesRotatableSecret('', 'ROT_TEST_SECRET')).toBe(false)
  expect(matchesRotatableSecret(null, 'ROT_TEST_SECRET')).toBe(false)
  expect(matchesRotatableSecret(undefined, 'ROT_TEST_SECRET')).toBe(false)
})

test('matchesRotatableSecret: незаданный env отклоняет всё, даже пустую строку', () => {
  expect(process.env.ROT_TEST_UNSET).toBeUndefined()
  expect(matchesRotatableSecret('anything', 'ROT_TEST_UNSET')).toBe(false)
  expect(matchesRotatableSecret('', 'ROT_TEST_UNSET')).toBe(false)
})
