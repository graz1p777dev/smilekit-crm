// Роли, которым разрешено трогать аварийный выключатель бота (integrations)
// и ручное управление ботом в конкретном чате (amocrm_chat_control).
// Вынесено в отдельный файл без внешних зависимостей, чтобы предикат можно
// было протестировать без моков Supabase.

const ALLOWED_ROLES = new Set(['owner', 'rop'])

export function isAllowedBotControlRole(role: string | null | undefined): boolean {
  return Boolean(role && ALLOWED_ROLES.has(role))
}
