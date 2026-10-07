// Одному человеку рассылка не чаще, чем раз в COOLDOWN_DAYS суток.
// Правило владельца (07.10.2026): получил рассылку — три дня не трогаем,
// после трёх суток он снова попадает в аудиторию.
//
// Граница считается от «сейчас», а не от начала суток: иначе вчерашний
// получатель снова оказался бы в списке уже на следующее утро.

export const REPEAT_COOLDOWN_DAYS = 3

/** С какого момента учитывать «уже получал рассылку», ISO. */
export function repeatCooldownSinceIso(now: number = Date.now()): string {
  return new Date(now - REPEAT_COOLDOWN_DAYS * 86_400_000).toISOString()
}

/**
 * Итоговая граница для подбора: правило трёх суток обойти нельзя, но более
 * раннюю (то есть более широкую) границу из формы уважаем.
 */
export function effectiveSkipReachedSince(requested: string | undefined, now: number = Date.now()): string {
  const cooldown = repeatCooldownSinceIso(now)
  return requested && requested < cooldown ? requested : cooldown
}
