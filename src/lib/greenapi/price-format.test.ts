import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

// «Цену нормально писать»: в текстах бота число и «сом» должны быть через
// пробел. Живой пример: «Со скидкой 1290сом» в дожиме после скидок.
describe('цены в текстах бота', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/lib/greenapi/bot-reply.ts'), 'utf8')

  it('нет склейки числа со словом «сом»', () => {
    const glued = source.match(/\d\s?(?=сом)\S?сом/gi)?.filter((m) => !/\d\sсом/.test(m)) ?? []
    expect(glued).toEqual([])
  })

  it('цена набора и ступени скидок — те, что в базе знаний', () => {
    expect(source).toContain('1490 сом')
    expect(source).toContain('1290 сом')
    expect(source).toContain('1190 сом')
  })
})
