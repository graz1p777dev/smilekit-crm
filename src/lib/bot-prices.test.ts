// Цена в текстах бота пишется по-человечески: «1490 сом», а не «1490сом».
//
// Живой баг: в POST_DISCOUNT_CAMPAIGN_TEXT было «Со скидкой 1290сом» — текст
// уходил клиентам в таком виде. Тест обходит ВСЕ экспортируемые строки
// текстовых модулей обоих каналов, поэтому новая склейка не проедет молча.

import { describe, expect, it } from 'vitest'
import * as greenApiBotReply from '@/lib/greenapi/bot-reply'
import * as greenApiTemplates from '@/lib/greenapi/default-templates'
import * as instagramTexts from '@/lib/instagram/texts'

/** Цифра, к которой вплотную приклеено «сом» — ровно то, что не должно попасть клиенту. */
const GLUED_PRICE = /\d(?:сом|СОМ|Сом)/

/** Разворачивает экспорт в плоский список строк: и одиночные тексты, и массивы вариантов. */
function stringsOf(module: Record<string, unknown>): [string, string][] {
  const result: [string, string][] = []
  for (const [name, value] of Object.entries(module)) {
    if (typeof value === 'string') result.push([name, value])
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === 'string') result.push([`${name}[${index}]`, item])
      })
    }
  }
  return result
}

const MODULES: [string, Record<string, unknown>][] = [
  ['greenapi/bot-reply', greenApiBotReply],
  ['greenapi/default-templates', greenApiTemplates],
  ['instagram/texts', instagramTexts],
]

describe('цена в текстах бота пишется через пробел перед «сом»', () => {
  for (const [moduleName, module] of MODULES) {
    for (const [exportName, text] of stringsOf(module)) {
      if (!/сом/i.test(text)) continue
      it(`${moduleName}: ${exportName}`, () => {
        expect(text).not.toMatch(GLUED_PRICE)
      })
    }
  }

  it('сам тест что-то проверяет — тексты с ценой в модулях есть', () => {
    const withPrice = MODULES.flatMap(([, module]) => stringsOf(module)).filter(([, text]) => /сом/i.test(text))
    expect(withPrice.length).toBeGreaterThan(3)
  })

  it('ловит склейку, если она вернётся', () => {
    expect('Со скидкой 1290сом').toMatch(GLUED_PRICE)
    expect('Со скидкой 1290 сом').not.toMatch(GLUED_PRICE)
  })
})
