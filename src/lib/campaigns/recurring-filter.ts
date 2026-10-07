// Какой фильтр аудитории у автоматической рассылки в данный момент.
// Одна функция на форму (живой подсчёт «сколько получат») и на планировщик
// (реальная отправка) — иначе число в форме разошлось бы с отправкой.

import type { AudienceFilter, CampaignAudience } from '@/actions/campaigns'
import { repeatCooldownSinceIso } from './repeat-cooldown'

export type RecurringPeriodMode = 'days' | 'hours24' | 'since_last' | 'from_date'

export interface RecurringAudienceOptions {
  audience: CampaignAudience
  period_mode: RecurringPeriodMode
  /** Для 'days': последние N суток по Бишкеку, null — без ограничения. */
  window_days: number | null
  /** Для 'from_date': 'YYYY-MM-DD' по Бишкеку. */
  from_date: string | null
  include_manager_chats: boolean
  skip_reached_today: boolean
}

/** Asia/Bishkek — круглый год UTC+6. */
const OFFSET_MS = 6 * 3600_000

/** Дата 'YYYY-MM-DD' по Бишкеку N суток назад. */
export function bishkekDay(now: number, daysAgo = 0): string {
  return new Date(now + OFFSET_MS - daysAgo * 86_400_000).toISOString().slice(0, 10)
}

/** Начало сегодняшних суток по Бишкеку, ISO. */
export function bishkekDayStartIso(now: number): string {
  return new Date(`${bishkekDay(now)}T00:00:00+06:00`).toISOString()
}

/**
 * Фильтр на момент now. null — считать не от чего (режим «с прошлой
 * рассылки», а рассылок ещё не было): такой запуск пропускается.
 */
export function recurringAudienceFilter(
  rule: RecurringAudienceOptions,
  now: number,
  lastCampaignAt: string | null
): AudienceFilter | null {
  const base: AudienceFilter = {
    audience: rule.audience,
    includeManagerChats: rule.include_manager_chats,
    // Правило трёх суток: кто получил рассылку за последние
    // REPEAT_COOLDOWN_DAYS суток, в аудиторию не попадает. Окно скользящее
    // (72 часа от момента отправки), а не календарное — иначе получивший
    // вчера в 20:00 снова попал бы в список уже через полтора суток.
    skipReachedSince: repeatCooldownSinceIso(now),
  }
  switch (rule.period_mode) {
    case 'hours24':
      return { ...base, from: new Date(now - 24 * 3600_000).toISOString() }
    case 'since_last':
      return lastCampaignAt ? { ...base, from: lastCampaignAt } : null
    case 'from_date':
      return rule.from_date ? { ...base, from: rule.from_date, to: bishkekDay(now) } : null
    case 'days':
    default:
      return rule.window_days
        ? { ...base, from: bishkekDay(now, rule.window_days - 1), to: bishkekDay(now) }
        : base
  }
}

/** Подпись периода для карточки правила. */
export function recurringPeriodLabel(rule: Pick<RecurringAudienceOptions, 'period_mode' | 'window_days' | 'from_date'>): string {
  switch (rule.period_mode) {
    case 'hours24': return 'писали за последние 24 часа'
    case 'since_last': return 'писали с прошлой рассылки'
    case 'from_date': {
      const [y, m, d] = (rule.from_date ?? '').split('-')
      return `писали с ${d}.${m}.${y}`
    }
    default:
      if (!rule.window_days) return 'без ограничения по дате'
      if (rule.window_days === 1) return 'только сегодняшние'
      return `писали за ${rule.window_days} дн.`
  }
}
