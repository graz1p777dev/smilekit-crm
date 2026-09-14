// Восстановление после деплоя.
//
// Next.js вшивает в клиентский бандл идентификатор каждого server action.
// После деплоя идентификаторы меняются, и вкладка, открытая ДО него, зовёт
// действие, которого на сервере уже нет:
//   Server Action "…" was not found on the server
// Пользователю это показывается как ошибка страницы, хотя чинится обычной
// перезагрузкой. Делаем перезагрузку сами — один раз, иначе при настоящей
// поломке страница уйдёт в бесконечный цикл.

const KEY = 'smilekit:stale-action-reload'
const COOLDOWN_MS = 30_000

export function isStaleServerAction(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('was not found on the server')
    || message.includes('Failed to find Server Action')
}

/**
 * Если ошибка — про устаревшее действие, перезагружает страницу и возвращает
 * true (вызывающему коду показывать ошибку уже не нужно).
 */
export function recoverFromStaleAction(error: unknown): boolean {
  if (!isStaleServerAction(error)) return false
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0)
    // Только что перезагружались, а ошибка та же — значит дело не в деплое.
    // Отдаём ошибку наверх, пусть её увидят.
    if (Date.now() - last < COOLDOWN_MS) return false
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    // Приватный режим — sessionStorage недоступен. Перезагрузимся без защиты
    // от цикла: лучше так, чем оставить пользователя с непонятной ошибкой.
  }
  window.location.reload()
  return true
}
