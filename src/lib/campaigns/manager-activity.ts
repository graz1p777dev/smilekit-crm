// Решение «можно ли слать рассылку в этот чат» с точки зрения менеджера.
// Вынесено отдельно и без обращений к базе, чтобы правило было проверяемо
// тестами: ошибка здесь либо заспамит клиентов посреди разговора, либо снова
// молча выкинет их из рассылки.

/**
 * Сколько менеджер должен молчать в чате, чтобы туда снова можно было слать
 * рассылку. Бизнес-правило владельца (17.09): 30 минут.
 */
export const MANAGER_ACTIVE_WINDOW_MS = 30 * 60_000

export interface ChatControlRow {
  bot_enabled: boolean
  updated_at: string
}

/**
 * true — менеджер ведёт этот чат прямо сейчас, рассылку сюда не шлём.
 *
 * Чат «у менеджера», если менеджер в нём писал или явно забрал его себе и
 * после этого чат не вернули боту. Но исключаем его, только если менеджер
 * был активен за последние MANAGER_ACTIVE_WINDOW_MS: активность — последнее
 * его сообщение или момент, когда он забрал чат.
 */
export function isManagerActiveInChat(
  lastOperatorAt: string | null,
  control: ChatControlRow | undefined,
  now: number,
  windowMs: number = MANAGER_ACTIVE_WINDOW_MS
): boolean {
  let heldByManager: boolean
  if (!control) {
    heldByManager = lastOperatorAt !== null
  } else {
    const overrideIsFresh = lastOperatorAt === null
      || new Date(control.updated_at).getTime() > new Date(lastOperatorAt).getTime()
    heldByManager = overrideIsFresh ? !control.bot_enabled : true
  }
  if (!heldByManager) return false

  const lastActivity = Math.max(
    lastOperatorAt ? new Date(lastOperatorAt).getTime() : 0,
    control && !control.bot_enabled ? new Date(control.updated_at).getTime() : 0,
  )
  return now - lastActivity < windowMs
}
