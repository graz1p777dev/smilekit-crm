// Типы клиентов для аналитики владельца. Пороги — только здесь.
//
// Факты по чату считает SQL (supabase/migrations/048_real_analytics.sql),
// здесь только правило «факты → тип», чтобы его можно было проверить тестами.
// «Сообщения диалога» = клиент + человек + бот (без рассылок и служебных).

export const CLIENT_TYPE_RULES = {
  /** Железный: сообщений диалога до первого заказа МЕНЬШЕ этого числа. */
  ironMessagesBelow: 10,
  /** Железный: от первого сообщения диалога до первого заказа МЕНЬШЕ стольких минут. */
  ironMinutesBelow: 60,
  /** Воздухан: всего сообщений диалога от… */
  airMinMessages: 3,
  /** …до (включительно). */
  airMaxMessages: 5,
} as const

export type ClientType = 'iron' | 'regular' | 'air' | 'short' | 'midAnswered' | 'long'

export interface ClientFacts {
  /** Первое сообщение диалога, мс. */
  firstDialogAt: number
  /** Всего сообщений диалога (на сейчас). */
  totalMsgs: number
  /** Первый заказ после первого сообщения клиента, мс; null — не купил. */
  firstOrderAt: number | null
  /** Сообщений диалога до первого заказа; null — не купил. */
  msgsBeforeOrder: number | null
  /** Человек писал после последнего сообщения клиента. */
  humanAfterLastClient: boolean
}

export function minutesToOrder(facts: ClientFacts): number | null {
  if (facts.firstOrderAt === null) return null
  return (facts.firstOrderAt - facts.firstDialogAt) / 60_000
}

export function classifyClient(facts: ClientFacts): ClientType {
  const r = CLIENT_TYPE_RULES
  if (facts.firstOrderAt !== null) {
    const minutes = minutesToOrder(facts) ?? Infinity
    const before = facts.msgsBeforeOrder ?? Infinity
    return before < r.ironMessagesBelow && minutes < r.ironMinutesBelow ? 'iron' : 'regular'
  }
  if (facts.totalMsgs < r.airMinMessages) return 'short'
  if (facts.totalMsgs <= r.airMaxMessages) {
    return facts.humanAfterLastClient ? 'midAnswered' : 'air'
  }
  return 'long'
}

/** Порядок и подписи — для интерфейса. */
export const CLIENT_TYPE_ORDER: ClientType[] = ['iron', 'regular', 'air', 'short', 'midAnswered', 'long']

export const CLIENT_TYPE_LABELS: Record<ClientType, { title: string; rule: string }> = {
  iron: {
    title: 'Железные',
    rule: `купили: до заказа меньше ${CLIENT_TYPE_RULES.ironMessagesBelow} сообщений и меньше часа от первого сообщения`,
  },
  regular: {
    title: 'Обычные',
    rule: `купили за ${CLIENT_TYPE_RULES.ironMessagesBelow}+ сообщений или дольше часа`,
  },
  air: {
    title: 'Воздуханы',
    rule: `узнали цену и не купили: ${CLIENT_TYPE_RULES.airMinMessages}–${CLIENT_TYPE_RULES.airMaxMessages} сообщений, менеджер после не писал`,
  },
  short: {
    title: `1–${CLIENT_TYPE_RULES.airMinMessages - 1} сообщения`,
    rule: `не купили, всего 1–${CLIENT_TYPE_RULES.airMinMessages - 1} сообщения в диалоге`,
  },
  midAnswered: {
    title: `${CLIENT_TYPE_RULES.airMinMessages}–${CLIENT_TYPE_RULES.airMaxMessages}, менеджер писал после`,
    rule: `не купили, ${CLIENT_TYPE_RULES.airMinMessages}–${CLIENT_TYPE_RULES.airMaxMessages} сообщений, человек писал после последнего сообщения клиента`,
  },
  long: {
    title: `${CLIENT_TYPE_RULES.airMaxMessages + 1}+ сообщений, не купили`,
    rule: `не купили, в диалоге ${CLIENT_TYPE_RULES.airMaxMessages + 1} и больше сообщений`,
  },
}

/** Короткое название для карточки клиента. */
export const CLIENT_TYPE_SHORT: Record<ClientType, string> = {
  iron: 'Железный',
  regular: 'Обычный',
  air: 'Воздухан',
  short: '—',
  midAnswered: '—',
  long: '—',
}

/** «45 мин», «3 ч 10 мин», «2 дн 4 ч» — без округления вверх. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
  if (totalMinutes < 60) return `${totalMinutes} мин`
  const hours = Math.floor(totalMinutes / 60)
  if (hours < 24) {
    const minutes = totalMinutes % 60
    return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`
  }
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours ? `${days} дн ${restHours} ч` : `${days} дн`
}
