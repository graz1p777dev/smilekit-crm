// Роли, которым разрешено трогать аварийный выключатель бота (integrations)
// и ручное управление ботом в конкретном чате (chat_control).
// Вынесено в отдельный файл без внешних зависимостей, чтобы предикат можно
// было протестировать без моков Supabase.

const ALLOWED_ROLES = new Set(['owner', 'rop'])

export function isAllowedBotControlRole(role: string | null | undefined): boolean {
  return Boolean(role && ALLOWED_ROLES.has(role))
}

// Бот в ОДНОМ чате: забрать себе и вернуть боту может каждый, кто ведёт
// сделки. Раньше вернуть мог только владелец или РОП — менеджер забирал чат
// и не мог отдать его обратно. Общий выключатель — по-прежнему только им.
const CHAT_CONTROL_ROLES = new Set(['owner', 'rop', 'mp', 'lmai'])

export function isAllowedChatControlRole(role: string | null | undefined): boolean {
  return Boolean(role && CHAT_CONTROL_ROLES.has(role))
}
