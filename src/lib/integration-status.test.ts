import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isIntegrationBotEnabled } from './integration-status.ts'

test('isIntegrationBotEnabled: is_active=false — выключен независимо от паузы', () => {
  assert.equal(isIntegrationBotEnabled({ is_active: false, paused_until: null }), false)
})

test('isIntegrationBotEnabled: is_active=true, паузы нет — включён', () => {
  assert.equal(isIntegrationBotEnabled({ is_active: true, paused_until: null }), true)
})

test('isIntegrationBotEnabled: is_active=true, пауза в будущем — выключен', () => {
  const future = new Date(Date.now() + 60_000).toISOString()
  assert.equal(isIntegrationBotEnabled({ is_active: true, paused_until: future }), false)
})

test('isIntegrationBotEnabled: is_active=true, пауза уже прошла — снова включён', () => {
  const past = new Date(Date.now() - 60_000).toISOString()
  assert.equal(isIntegrationBotEnabled({ is_active: true, paused_until: past }), true)
})

test('isIntegrationBotEnabled: строка не найдена (null) — выключен', () => {
  assert.equal(isIntegrationBotEnabled(null), false)
})
