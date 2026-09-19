// Воронка бота по новым лидам. SQL (analytics_bot_lead_funnel, 054) отдаёт
// число лидов по каждой комбинации фактов (битовая маска), здесь — порядок
// шагов и строгий счёт: шаг засчитан, только если пройдены все предыдущие.

export interface FunnelStepDef {
  bit: number
  label: string
  rule: string
}

export const BOT_FUNNEL_STEPS: FunnelStepDef[] = [
  { bit: 1, label: 'Написал', rule: 'Новый лид: самое первое сообщение клиента — в эти дни.' },
  { bit: 2, label: 'Бот ответил', rule: 'Бот написал в чат после первого сообщения клиента.' },
  { bit: 4, label: 'Спросил город', rule: 'В чате есть служебная метка бота «ожидание города» (city-wait).' },
  { bit: 8, label: 'Клиент ответил про город', rule: 'Клиент написал после вопроса о городе (после метки city-wait).' },
  { bit: 16, label: 'Отправлены фото до/после', rule: 'В чате есть метка бота «фото до/после» (results).' },
  { bit: 32, label: 'Клиент ответил после фото', rule: 'Клиент написал после метки «фото до/после».' },
  { bit: 64, label: 'Передан менеджеру', rule: 'В чате есть метка «передано менеджеру» (handed-off).' },
  { bit: 128, label: 'Человек ответил после передачи', rule: 'Сообщение человека (с телефона или из CRM, не рассылка) после последней карточки передачи.' },
  { bit: 256, label: 'Купил', rule: 'Заказ (не отменён) с номера клиента после его первого сообщения, в любой момент до сейчас.' },
]

export const BOUGHT_BIT = 256
export const HANDED_BIT = 64

export interface FunnelStep extends FunnelStepDef {
  /** Прошли этот шаг и все предыдущие. */
  reached: number
  /** Потеря от прошлого шага, доля 0…1; у первого шага — null. */
  lossFromPrev: number | null
  /** Сколько лидов имеют этот факт вообще, в любом порядке. */
  anyOrder: number
}

export interface BotFunnel {
  leads: number
  steps: FunnelStep[]
  boughtTotal: number
  boughtWithoutHandoff: number
}

export function buildBotFunnel(leads: number, masks: Record<string, number>): BotFunnel {
  const entries = Object.entries(masks).map(([mask, n]) => [Number(mask), n] as const)
  const count = (test: (mask: number) => boolean) => entries.reduce((sum, [mask, n]) => (test(mask) ? sum + n : sum), 0)

  let required = 0
  let prev: number | null = null
  const steps = BOT_FUNNEL_STEPS.map((def) => {
    required |= def.bit
    const need = required
    const reached = count((mask) => (mask & need) === need)
    const step: FunnelStep = {
      ...def,
      reached,
      lossFromPrev: prev === null ? null : prev === 0 ? 0 : (prev - reached) / prev,
      anyOrder: count((mask) => (mask & def.bit) !== 0),
    }
    prev = reached
    return step
  })

  return {
    leads,
    steps,
    boughtTotal: count((mask) => (mask & BOUGHT_BIT) !== 0),
    boughtWithoutHandoff: count((mask) => (mask & BOUGHT_BIT) !== 0 && (mask & HANDED_BIT) === 0),
  }
}
