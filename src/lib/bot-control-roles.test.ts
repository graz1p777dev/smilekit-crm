import { expect, test } from 'vitest'
import { isAllowedBotControlRole } from './bot-control-roles'

test('isAllowedBotControlRole: owner разрешён', () => {
  expect(isAllowedBotControlRole('owner')).toBe(true)
})

test('isAllowedBotControlRole: rop разрешён', () => {
  expect(isAllowedBotControlRole('rop')).toBe(true)
})

test('isAllowedBotControlRole: mp/lmai/accountant запрещены', () => {
  expect(isAllowedBotControlRole('mp')).toBe(false)
  expect(isAllowedBotControlRole('lmai')).toBe(false)
  expect(isAllowedBotControlRole('accountant')).toBe(false)
})

test('isAllowedBotControlRole: null/undefined/пустая строка запрещены', () => {
  expect(isAllowedBotControlRole(null)).toBe(false)
  expect(isAllowedBotControlRole(undefined)).toBe(false)
  expect(isAllowedBotControlRole('')).toBe(false)
})
