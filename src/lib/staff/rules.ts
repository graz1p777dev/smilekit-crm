// Правила смен без базы и сети — чтобы их можно было проверить тестами.
// Сами правила задал владелец:
//   • 5 неверных паролей — блок на 5 минут;
//   • «Моя смена» и «Работа вместе» при занятой смене — только после
//     подтверждения того, кто на смене (или владельца): иначе сотрудник,
//     который ничего не делает, нажмёт кнопку и заберёт себе чужих лидов;
//   • клиент ждёт ответа 15 минут — напоминание тому, кто на смене.

export const LOGIN_MAX_FAILURES = 5
export const LOGIN_BLOCK_MS = 5 * 60_000
/** Запрос без решения не висит вечно: подтверждение через час неожиданно начало бы смену. */
export const SHIFT_REQUEST_TTL_MS = 30 * 60_000
export const REPLY_REMINDER_AFTER_MS = 15 * 60_000

export type ShiftRequestKind = 'take' | 'join'
export type ShiftMode = 'solo' | 'joint'

export type ShiftStartPlan =
  | { type: 'already_on_shift' }
  | { type: 'start'; mode: ShiftMode }
  | { type: 'request'; onShiftIds: string[] }

/** Что делать по нажатию «Моя смена» / «Работа вместе». */
export function planShiftStart(onShiftIds: string[], requesterId: string): ShiftStartPlan {
  if (onShiftIds.includes(requesterId)) return { type: 'already_on_shift' }
  // На смене никого — подтверждать некому и забирать не у кого.
  if (onShiftIds.length === 0) return { type: 'start', mode: 'solo' }
  return { type: 'request', onShiftIds: [...onShiftIds] }
}

/**
 * Что сделать при подтверждении запроса. Состояние берётся на момент
 * подтверждения, а не запроса: за это время смена могла закрыться сама.
 */
export function planApproval(
  kind: ShiftRequestKind,
  onShiftIdsNow: string[],
  requesterId: string
): { close: string[]; startMode: ShiftMode | null } {
  const others = onShiftIdsNow.filter((id) => id !== requesterId)
  const alreadyOn = onShiftIdsNow.includes(requesterId)
  if (kind === 'take') {
    return { close: others, startMode: alreadyOn ? null : 'solo' }
  }
  return { close: [], startMode: alreadyOn ? null : others.length ? 'joint' : 'solo' }
}

export type Decider = { kind: 'owner' } | { kind: 'link' } | { kind: 'staff'; staffId: string }

/**
 * Подтверждать может тот, кто был на смене в момент запроса, владелец или
 * получатель ссылки из WhatsApp (ссылка уходит только им). Сам себе —
 * никогда: ради этого подтверждение и придумано.
 */
export function canDecide(onShiftIdsAtRequest: string[], requesterId: string, decider: Decider): boolean {
  if (decider.kind !== 'staff') return true
  if (decider.staffId === requesterId) return false
  return onShiftIdsAtRequest.includes(decider.staffId)
}

export function isRequestExpired(createdAt: string, now: number): boolean {
  return now - new Date(createdAt).getTime() >= SHIFT_REQUEST_TTL_MS
}

export interface LoginGuardState {
  failures: number
  blockedUntil: string | null
}

/** Сколько ещё ждать до новой попытки, мс. 0 — можно пробовать. */
export function loginBlockRemainingMs(state: LoginGuardState | null, now: number): number {
  if (!state?.blockedUntil) return 0
  return Math.max(0, new Date(state.blockedUntil).getTime() - now)
}

/** Состояние после неверного пароля. Истёкший блок начинает счёт заново. */
export function afterLoginFailure(state: LoginGuardState | null, now: number): LoginGuardState {
  const blockExpired = Boolean(state?.blockedUntil) && loginBlockRemainingMs(state, now) === 0
  const failures = (blockExpired ? 0 : state?.failures ?? 0) + 1
  if (failures >= LOGIN_MAX_FAILURES) {
    return { failures, blockedUntil: new Date(now + LOGIN_BLOCK_MS).toISOString() }
  }
  return { failures, blockedUntil: null }
}

export function attemptsLeft(state: LoginGuardState): number {
  return Math.max(0, LOGIN_MAX_FAILURES - state.failures)
}

/** Пароль сотрудника: простой, но не пустой. */
export function validateStaffPassword(password: string): string | null {
  const value = password.trim()
  if (value.length < 3) return 'Пароль — минимум 3 символа'
  if (value.length > 50) return 'Пароль — не длиннее 50 символов'
  return null
}

/** Телефон в формате chat_id: только цифры. Местный 0XXXXXXXXX → 996XXXXXXXXX. */
export function normalizeStaffPhone(phone: string): string | null {
  let digits = phone.replace(/\D/g, '')
  if (digits.length === 10 && digits.startsWith('0')) digits = `996${digits.slice(1)}`
  if (digits.length === 9) digits = `996${digits}`
  return /^[0-9]{11,15}$/.test(digits) ? digits : null
}

/** «8 ч 05 мин» */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h} ч ${String(m).padStart(2, '0')} мин` : `${m} мин`
}

/** «14:05» по Бишкеку. */
export function bishkekTime(value: string | Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Bishkek', hour: '2-digit', minute: '2-digit',
  }).format(typeof value === 'string' ? new Date(value) : value)
}
