import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedBotControlRole } from './bot-control-roles.ts'

test('isAllowedBotControlRole: owner разрешён', () => {
  assert.equal(isAllowedBotControlRole('owner'), true)
})

test('isAllowedBotControlRole: rop разрешён', () => {
  assert.equal(isAllowedBotControlRole('rop'), true)
})

test('isAllowedBotControlRole: mp/lmai/accountant запрещены', () => {
  assert.equal(isAllowedBotControlRole('mp'), false)
  assert.equal(isAllowedBotControlRole('lmai'), false)
  assert.equal(isAllowedBotControlRole('accountant'), false)
})

test('isAllowedBotControlRole: null/undefined/пустая строка запрещены', () => {
  assert.equal(isAllowedBotControlRole(null), false)
  assert.equal(isAllowedBotControlRole(undefined), false)
  assert.equal(isAllowedBotControlRole(''), false)
})
