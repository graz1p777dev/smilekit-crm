// Эффективный статус интеграции с учётом временной паузы (paused_until,
// см. миграцию 20260907120000_integrations_paused_until.sql). Once
// paused_until проходит, бот сам возобновляется на следующем чтении —
// фоновый джоб не нужен.

export interface IntegrationStatusRow {
  is_active?: boolean | null
  paused_until?: string | null
}

export function isIntegrationBotEnabled(row: IntegrationStatusRow | null | undefined): boolean {
  if (!row?.is_active) return false
  if (!row.paused_until) return true
  return new Date(row.paused_until) <= new Date()
}
