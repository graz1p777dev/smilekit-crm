// Город из ответа клиента на вопрос бота «из какого вы города?».
// Чистая функция: словарь городов Кыргызстана, Казахстана и Узбекистана,
// частые написания (кириллица/латиница, падежи, опечатки в одну букву).
// Не угадывает: если ничего из словаря не нашлось — null («не распознано»).

export type Country = 'KG' | 'KZ' | 'UZ'

export interface CityMatch {
  city: string
  country: Country
}

interface Entry {
  city: string
  country: Country
  /** Написания в нормализованном виде (см. normalizeCityText). */
  aliases: string[]
}

const KG = 'KG' as const
const KZ = 'KZ' as const
const UZ = 'UZ' as const

const ENTRIES: Entry[] = [
  // ── Кыргызстан ──
  { city: 'Бишкек', country: KG, aliases: ['бишкек', 'бищкек', 'бишкеке', 'bishkek', 'bishkeke', 'фрунзе', 'биш'] },
  { city: 'Ош', country: KG, aliases: ['ош', 'оша', 'оше', 'ошто', 'оштон', 'osh'] },
  { city: 'Джалал-Абад', country: KG, aliases: ['джалал абад', 'жалал абад', 'джалалабад', 'жалалабад', 'джала абад', 'жала абад', 'jalal abad', 'jalalabad', 'djalal abad'] },
  { city: 'Каракол', country: KG, aliases: ['каракол', 'кара кол', 'karakol', 'пржевальск'] },
  { city: 'Токмок', country: KG, aliases: ['токмок', 'токмак', 'tokmok', 'tokmak'] },
  { city: 'Нарын', country: KG, aliases: ['нарын', 'naryn'] },
  { city: 'Талас', country: KG, aliases: ['талас', 'talas'] },
  { city: 'Баткен', country: KG, aliases: ['баткен', 'batken'] },
  { city: 'Кара-Балта', country: KG, aliases: ['кара балт', 'карабалт', 'kara balta', 'karabalta'] },
  { city: 'Балыкчы', country: KG, aliases: ['балыкчы', 'балыкчи', 'рыбачье', 'balykchy'] },
  { city: 'Кант', country: KG, aliases: ['кант', 'kant'] },
  { city: 'Кызыл-Кия', country: KG, aliases: ['кызыл кыя', 'кызыл кия', 'кызылкия', 'кызылкыя', 'kyzyl kiya'] },
  { city: 'Узген', country: KG, aliases: ['узген', 'озгон', 'uzgen'] },
  { city: 'Майлуу-Суу', country: KG, aliases: ['майлуу суу', 'майлуусуу', 'майли суу', 'майлису', 'mailuu suu'] },
  { city: 'Таш-Кумыр', country: KG, aliases: ['таш кумыр', 'ташкумыр'] },
  { city: 'Кочкор-Ата', country: KG, aliases: ['кочкор ата', 'кочкората'] },
  { city: 'Токтогул', country: KG, aliases: ['токтогул', 'toktogul'] },
  { city: 'Чолпон-Ата', country: KG, aliases: ['чолпон ата', 'чолпоната', 'cholpon ata'] },
  { city: 'Исфана', country: KG, aliases: ['исфана'] },
  { city: 'Сулюкта', country: KG, aliases: ['сулюкта', 'сулукту'] },
  { city: 'Ноокат', country: KG, aliases: ['ноокат'] },
  { city: 'Кара-Суу', country: KG, aliases: ['кара суу', 'карасуу'] },
  { city: 'Базар-Коргон', country: KG, aliases: ['базар коргон', 'базаркоргон'] },
  { city: 'Сокулук', country: KG, aliases: ['сокулук'] },
  { city: 'Беловодское', country: KG, aliases: ['беловодское', 'беловодск', 'беловодский'] },
  { city: 'Кемин', country: KG, aliases: ['кемин'] },
  { city: 'Кербен', country: KG, aliases: ['кербен', 'ала бука', 'алабука'] },
  { city: 'Кадамжай', country: KG, aliases: ['кадамжай'] },
  { city: 'Манас', country: KG, aliases: ['манас'] },
  { city: 'Ивановка', country: KG, aliases: ['ивановка'] },
  { city: 'Петровка', country: KG, aliases: ['петровка'] },
  { city: 'Кочкор', country: KG, aliases: ['кочкор', 'кочкорка'] },
  { city: 'Шопоков', country: KG, aliases: ['шопоков'] },
  { city: 'Кызыл-Суу', country: KG, aliases: ['кызыл суу', 'кызылсуу'] },
  { city: 'Араван', country: KG, aliases: ['араван'] },
  { city: 'Бостери', country: KG, aliases: ['бостери'] },
  { city: 'Тюп', country: KG, aliases: ['тюп'] },
  { city: 'Боконбаево', country: KG, aliases: ['боконбаево', 'боконбай'] },
  { city: 'Лебединовка', country: KG, aliases: ['лебединовка'] },
  { city: 'Новопавловка', country: KG, aliases: ['новопавловка'] },
  { city: 'Кара-Кульджа', country: KG, aliases: ['кара кулжа', 'кара кульджа'] },
  { city: 'Ат-Башы', country: KG, aliases: ['ат башы', 'ат баши', 'атбашы'] },
  { city: 'Кара-Куль', country: KG, aliases: ['кара куль', 'каракуль'] },
  // ── Казахстан ──
  { city: 'Кордай', country: KZ, aliases: ['кордай'] },
  { city: 'Сортобе', country: KZ, aliases: ['сортобе'] },
  { city: 'Алматы', country: KZ, aliases: ['алматы', 'алма ата', 'алмата', 'almaty', 'alma ata'] },
  { city: 'Астана', country: KZ, aliases: ['астана', 'нур султан', 'astana'] },
  { city: 'Шымкент', country: KZ, aliases: ['шымкент', 'чимкент', 'shymkent'] },
  { city: 'Караганда', country: KZ, aliases: ['караганда', 'karaganda'] },
  { city: 'Тараз', country: KZ, aliases: ['тараз', 'джамбул', 'taraz'] },
  { city: 'Актобе', country: KZ, aliases: ['актобе', 'актюбинск', 'aktobe'] },
  { city: 'Павлодар', country: KZ, aliases: ['павлодар'] },
  { city: 'Усть-Каменогорск', country: KZ, aliases: ['усть каменогорск', 'оскемен'] },
  // «семей» и «орал» — обычные русские слова, поэтому не в словаре.
  { city: 'Семей', country: KZ, aliases: ['семипалатинск', 'semey'] },
  { city: 'Атырау', country: KZ, aliases: ['атырау'] },
  { city: 'Костанай', country: KZ, aliases: ['костанай', 'кустанай'] },
  { city: 'Кызылорда', country: KZ, aliases: ['кызылорда', 'кызыл орда'] },
  { city: 'Уральск', country: KZ, aliases: ['уральск'] },
  { city: 'Петропавловск', country: KZ, aliases: ['петропавловск'] },
  { city: 'Актау', country: KZ, aliases: ['актау'] },
  { city: 'Туркестан', country: KZ, aliases: ['туркестан'] },
  { city: 'Талдыкорган', country: KZ, aliases: ['талдыкорган'] },
  // ── Узбекистан ──
  { city: 'Ташкент', country: UZ, aliases: ['ташкент', 'тошкент', 'tashkent', 'toshkent'] },
  { city: 'Самарканд', country: UZ, aliases: ['самарканд', 'samarkand', 'samarqand'] },
  { city: 'Бухара', country: UZ, aliases: ['бухара', 'buxoro', 'bukhara'] },
  { city: 'Наманган', country: UZ, aliases: ['наманган', 'namangan'] },
  { city: 'Андижан', country: UZ, aliases: ['андижан', 'andijan', 'andijon'] },
  { city: 'Фергана', country: UZ, aliases: ['фергана', 'fergana', 'fargona'] },
  { city: 'Коканд', country: UZ, aliases: ['коканд', 'kokand', 'qoqon'] },
  { city: 'Карши', country: UZ, aliases: ['карши', 'qarshi'] },
  { city: 'Нукус', country: UZ, aliases: ['нукус', 'nukus'] },
  { city: 'Ургенч', country: UZ, aliases: ['ургенч', 'urgench'] },
  { city: 'Джизак', country: UZ, aliases: ['джизак', 'jizzax', 'jizzakh'] },
  { city: 'Термез', country: UZ, aliases: ['термез', 'termiz'] },
  { city: 'Навои', country: UZ, aliases: ['навои', 'navoiy'] },
  { city: 'Маргилан', country: UZ, aliases: ['маргилан', 'margilan'] },
  { city: 'Чирчик', country: UZ, aliases: ['чирчик', 'chirchiq'] },
]

/** Область без города — только если город не назван. */
const REGIONS: Entry[] = [
  { city: 'Чуйская область, город не назван', country: KG, aliases: ['чуй', 'чуйская'] },
  { city: 'Иссык-Кульская область, город не назван', country: KG, aliases: ['иссык куль', 'иссыккуль', 'ысык кол', 'ыссык кол', 'ысыккол', 'issyk kul'] },
]

/** Страна без города — отдельная строка «город не назван». */
const COUNTRIES: Entry[] = [
  { city: 'Кыргызстан, город не назван', country: KG, aliases: ['кыргызстан', 'кыргызтан', 'кыргыстан', 'киргизия', 'киргизтан', 'кыргызыстан', 'kyrgyzstan'] },
  { city: 'Казахстан, город не назван', country: KZ, aliases: ['казахстан', 'kazakhstan'] },
  { city: 'Узбекистан, город не назван', country: UZ, aliases: ['узбекистан', 'uzbekistan', 'ozbekiston'] },
]

/** Нижний регистр, ё→е, кыргызские буквы → русские, всё кроме букв — пробел. */
export function normalizeCityText(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/ө/g, 'о')
    .replace(/ү/g, 'у')
    .replace(/ң/g, 'н')
    .replace(/[^a-zа-я]+/g, ' ')
    .trim()
}

function levenshtein1(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else { i++; j++ }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

// Падежные окончания и кыргызские аффиксы после названия: «из Бишкека»,
// «в Бишкеке», «Бишкекте», «Нарындан», «Өзгөндөн». Прилагательные
// («Нарынская область») сюда нарочно не входят: область — не город.
const ENDING = '(?:а|е|у|ом|ой|ы|и|я|ка|ке|те|та|тан|тен|тон|дан|ден|дон|нан|нен|да|де|до|са)?'

interface Found extends CityMatch {
  at: number
  len: number
}

// «Баткен облусу», «Нарын область», «Ош район» — область или район с тем же
// именем, а не сам город: такое упоминание городом не считаем.
const AREA_WORD = /^(?:обл|район|р$|р н)/

function findIn(norm: string, entries: Entry[], skipAreas: boolean): Found | null {
  let best: Found | null = null
  const consider = (f: Found) => {
    if (!best || f.at < best.at || (f.at === best.at && f.len > best.len)) best = f
  }
  const isArea = (end: number) => skipAreas && AREA_WORD.test(norm.slice(end + 1))
  const tokens = norm.split(' ')
  for (const e of entries) {
    for (const alias of e.aliases) {
      // Точное написание (с окончанием для длинных названий).
      const tail = alias.length >= 4 ? ENDING : ''
      for (const m of norm.matchAll(new RegExp(`(?:^| )(${alias}${tail})(?= |$)`, 'g'))) {
        const at = m.index + m[0].length - m[1].length
        if (!isArea(at + m[1].length)) consider({ city: e.city, country: e.country, at, len: alias.length })
      }
      // Опечатка в одну букву — только для однословных длинных названий.
      if (!alias.includes(' ') && alias.length >= 6) {
        let pos = 0
        for (const t of tokens) {
          if (levenshtein1(t, alias) && !isArea(pos + t.length)) {
            consider({ city: e.city, country: e.country, at: pos, len: alias.length })
          }
          pos += t.length + 1
        }
      }
    }
  }
  return best
}

/** Город из свободного текста клиента; null — не распознано. */
export function detectCity(text: string | null | undefined): CityMatch | null {
  const norm = normalizeCityText(text ?? '')
  if (!norm) return null
  const found = findIn(norm, ENTRIES, true) ?? findIn(norm, REGIONS, false) ?? findIn(norm, COUNTRIES, false)
  return found ? { city: found.city, country: found.country } : null
}
