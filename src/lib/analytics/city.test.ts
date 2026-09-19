import { describe, expect, it } from 'vitest'
import { detectCity, normalizeCityText } from './city'

const city = (text: string) => detectCity(text)?.city ?? null

describe('detectCity', () => {
  it('узнаёт частые ответы из переписки', () => {
    expect(city('Бишкек')).toBe('Бишкек')
    expect(city('из Бишкека')).toBe('Бишкек')
    expect(city('Я из Бишкека')).toBe('Бишкек')
    expect(city('в Бишкеке')).toBe('Бишкек')
    expect(city('Бишкекте')).toBe('Бишкек')
    expect(city('г.Бишкек')).toBe('Бишкек')
    expect(city('Здравствуйте, Бишкек')).toBe('Бишкек')
    expect(city('Бишкек кок жар')).toBe('Бишкек')
    expect(city('Ош')).toBe('Ош')
    expect(city('город Ош')).toBe('Ош')
    expect(city('из Оша')).toBe('Ош')
    expect(city('в Оше')).toBe('Ош')
    expect(city('г.ош')).toBe('Ош')
    expect(city('Кара-Балта')).toBe('Кара-Балта')
    expect(city('кара балта')).toBe('Кара-Балта')
    expect(city('Карабалта')).toBe('Кара-Балта')
    expect(city('Жалал-Абад')).toBe('Джалал-Абад')
    expect(city('из Жалал абада')).toBe('Джалал-Абад')
    expect(city('Чолпон-Ата')).toBe('Чолпон-Ата')
    expect(city('Ысык Көл')).toBe('Иссык-Кульская область, город не назван')
    expect(city('Өзгөн')).toBe('Узген')
    expect(city('Өзгөндөн байланыштым')).toBe('Узген')
    expect(city('из кара балты')).toBe('Кара-Балта')
    expect(city('кара кол')).toBe('Каракол')
    expect(city('манасса')).toBe('Манас')
    expect(city('Токмак')).toBe('Токмок')
    expect(city('Нарындан')).toBe('Нарын')
  })

  it('латиница и опечатки в одну букву', () => {
    expect(city('bishkek')).toBe('Бишкек')
    expect(city('Batken')).toBe('Баткен')
    expect(city('Бищкек')).toBe('Бишкек')
    expect(city('Бишкке')).toBe('Бишкек')
    expect(city('Almaty')).toBe('Алматы')
    expect(city('Toshkent')).toBe('Ташкент')
  })

  it('Казахстан и Узбекистан', () => {
    expect(city('Алматы')).toBe('Алматы')
    expect(city('Алма-Ата')).toBe('Алматы')
    expect(city('Шымкент')).toBe('Шымкент')
    expect(city('Ташкент')).toBe('Ташкент')
    expect(detectCity('Самарканд')?.country).toBe('UZ')
  })

  it('первый названный город, если их несколько', () => {
    expect(city('Ош Узген')).toBe('Ош')
    expect(city('Кыргызстан Бишкек')).toBe('Бишкек')
  })

  it('город важнее области, область — не город', () => {
    expect(city('Чуй Бишкек')).toBe('Бишкек')
    expect(city('Ошская область город Узген')).toBe('Узген')
    expect(city('Нарынская область')).toBeNull()
    expect(city('Нарын область Жумгал район')).toBeNull()
    expect(city('Баткен облусу')).toBeNull()
    expect(city('жалал абад область город кочкор ата')).toBe('Кочкор-Ата')
    expect(city('г.Ош район Кара-Кулжа')).toBe('Кара-Кульджа')
    expect(city('Нарын')).toBe('Нарын')
    expect(city('Чуйская обл')).toBe('Чуйская область, город не назван')
  })

  it('страна без города — отдельно', () => {
    expect(city('Кыргызстан')).toBe('Кыргызстан, город не назван')
    expect(city('из Кыргызстана')).toBe('Кыргызстан, город не назван')
    expect(city('Узбекистан')).toBe('Узбекистан, город не назван')
  })

  it('не угадывает', () => {
    expect(city('Улыбка')).toBeNull()
    expect(city('Здравствуйте')).toBeNull()
    expect(city('хорошо')).toBeNull()
    expect(city('да')).toBeNull()
    expect(city('сколько стоит')).toBeNull()
    expect(city('много семей')).toBeNull()
    expect(city('Москва')).toBeNull()
    expect(city('')).toBeNull()
    expect(city('👍')).toBeNull()
  })

  it('нормализация', () => {
    expect(normalizeCityText('  Кара-Балта!! ')).toBe('кара балта')
    expect(normalizeCityText('Ёлки')).toBe('елки')
  })
})
