// Раскладка доски: какие сделки показывать и в каком порядке.
// Приём подсмотрен на доске DemiResults, но опирается только на поля,
// которые у сделок SmileKit уже есть, — новых таблиц не требует.

import type { Deal } from '@/types'

export type DealView = 'active' | 'won' | 'lost'
export type DealSort = 'stage-asc' | 'updated-desc' | 'created-desc' | 'amount-desc' | 'amount-asc'

export const DEAL_VIEWS: { key: DealView; label: string }[] = [
  { key: 'active', label: 'В работе' },
  { key: 'won', label: 'Успешные' },
  { key: 'lost', label: 'Отказ' },
]

export const DEAL_SORTS: { key: DealSort; label: string }[] = [
  { key: 'stage-asc', label: 'Дольше всех в этапе' },
  { key: 'updated-desc', label: 'Недавно изменённые' },
  { key: 'created-desc', label: 'Новые' },
  { key: 'amount-desc', label: 'Сумма ↓' },
  { key: 'amount-asc', label: 'Сумма ↑' },
]

const time = (value: string | null | undefined, fallback: number) =>
  value ? new Date(value).getTime() : fallback

/** Сортирует НА МЕСТЕ: список уже наш, копия ни к чему. */
export function sortDeals(deals: Deal[], sort: DealSort): Deal[] {
  return deals.sort((a, b) => {
    switch (sort) {
      // Самая полезная сортировка в воронке: наверху то, что зависло дольше
      // всех и требует внимания, а не то, что только что создано.
      case 'stage-asc': return time(a.stage_changed_at, 0) - time(b.stage_changed_at, 0)
      case 'updated-desc': return time(b.updated_at, 0) - time(a.updated_at, 0)
      case 'created-desc': return time(b.created_at, 0) - time(a.created_at, 0)
      case 'amount-desc': return Number(b.amount ?? 0) - Number(a.amount ?? 0)
      case 'amount-asc': return Number(a.amount ?? 0) - Number(b.amount ?? 0)
      default: return 0
    }
  })
}
