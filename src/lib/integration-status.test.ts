import { expect, test } from 'vitest'
import { isIntegrationBotEnabled } from './integration-status'

test('isIntegrationBotEnabled: is_active=false — выключен независимо от паузы', () => {
  expect(isIntegrationBotEnabled({ is_active: false, paused_until: null })).toBe(false)
})

test('isIntegrationBotEnabled: is_active=true, паузы нет — включён', () => {
  expect(isIntegrationBotEnabled({ is_active: true, paused_until: null })).toBe(true)
})

test('isIntegrationBotEnabled: is_active=true, пауза в будущем — выключен', () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  expect(isIntegrationBotEnabled({ is_active: true, paused_until: future })).toBe(false)
})

test('isIntegrationBotEnabled: is_active=true, пауза уже прошла — снова включён', () => {
  const past = new Date(Date.now() - 60_000).toISOString()
  expect(isIntegrationBotEnabled({ is_active: true, paused_until: past })).toBe(true)
})

test('isIntegrationBotEnabled: строка не найдена (null) — выключен', () => {
  expect(isIntegrationBotEnabled(null)).toBe(false)
})
