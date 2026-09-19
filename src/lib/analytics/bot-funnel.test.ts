import { describe, expect, it } from 'vitest'
import { buildBotFunnel } from './bot-funnel'

describe('buildBotFunnel', () => {
  it('считает шаг только после всех предыдущих', () => {
    // 1+2 (бот ответил), 1+2+4 (спросил город), 1+64 (передан без ответа бота), 1+2+4+8+256
    const f = buildBotFunnel(10, { '3': 4, '7': 3, '65': 1, '271': 2 })
    const reached = f.steps.map((s) => s.reached)
    expect(reached.slice(0, 5)).toEqual([10, 9, 5, 2, 0])
    expect(f.steps[1].lossFromPrev).toBeCloseTo(0.1)
    expect(f.steps[0].lossFromPrev).toBeNull()
    // Передан вообще — 1 (без ответа бота), но в строгой воронке — 0.
    expect(f.steps[6].anyOrder).toBe(1)
    expect(f.steps[6].reached).toBe(0)
    expect(f.boughtTotal).toBe(2)
    expect(f.boughtWithoutHandoff).toBe(2)
  })

  it('пустой период — нули без деления на ноль', () => {
    const f = buildBotFunnel(0, {})
    expect(f.steps.every((s) => s.reached === 0)).toBe(true)
    expect(f.steps[3].lossFromPrev).toBe(0)
  })
})
