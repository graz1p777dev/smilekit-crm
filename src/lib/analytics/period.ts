// Период аналитики. Дни — по Бишкеку (UTC+6 круглый год), целиком.

export type PeriodKind = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'all' | 'custom'

export interface PeriodInput {
  kind: PeriodKind
  /** Только для custom: 'YYYY-MM-DD' (первый и последний день включительно). */
  from?: string
  to?: string
}

export interface PeriodRange {
  /** Начало первого дня, ISO UTC. */
  fromIso: string
  /** Начало дня ПОСЛЕ последнего, ISO UTC (граница не включается). */
  toIso: string
  /** Первый и последний день, 'YYYY-MM-DD' по Бишкеку. */
  firstDay: string
  lastDay: string
}

const OFFSET_MS = 6 * 3600_000
const DAY_MS = 86_400_000
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
export const MAX_CUSTOM_DAYS = 366
/** Раньше этой даты в базе нет ни переписки, ни заказов — начало «За всё время». */
export const DATA_START_DAY = '2026-08-01'

const dayStartUtc = (day: string) => Date.parse(`${day}T00:00:00Z`) - OFFSET_MS
const dayOf = (utcMs: number) => new Date(utcMs + OFFSET_MS).toISOString().slice(0, 10)

export function bishkekToday(now = Date.now()): string {
  return dayOf(now)
}

export function resolvePeriod(input: PeriodInput, now = Date.now()): PeriodRange {
  const today = bishkekToday(now)
  const todayStart = dayStartUtc(today)
  let first: string
  let last = today

  switch (input.kind) {
    case 'today':
      first = today
      break
    case 'yesterday':
      first = dayOf(todayStart - DAY_MS)
      last = first
      break
    case '7d':
      first = dayOf(todayStart - 6 * DAY_MS)
      break
    case '30d':
      first = dayOf(todayStart - 29 * DAY_MS)
      break
    case 'month':
      first = `${today.slice(0, 7)}-01`
      break
    case 'all':
      first = DATA_START_DAY
      break
    case 'custom': {
      const from = input.from ?? ''
      const to = input.to ?? ''
      if (!DAY_RE.test(from) || !DAY_RE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
        throw new Error('Неверные даты периода')
      }
      if (from > to) throw new Error('Начало периода позже конца')
      if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_CUSTOM_DAYS) {
        throw new Error(`Период длиннее ${MAX_CUSTOM_DAYS} дней`)
      }
      first = from
      last = to
      break
    }
    default:
      throw new Error('Неизвестный период')
  }

  return {
    fromIso: new Date(dayStartUtc(first)).toISOString(),
    toIso: new Date(dayStartUtc(last) + DAY_MS).toISOString(),
    firstDay: first,
    lastDay: last,
  }
}

/** Все дни периода, 'YYYY-MM-DD'. */
export function daysOf(range: PeriodRange): string[] {
  const days: string[] = []
  for (let t = Date.parse(`${range.firstDay}T00:00:00Z`); ; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10)
    days.push(day)
    if (day >= range.lastDay) break
  }
  return days
}
