// Фоновые задачи сервера CRM. Next.js вызывает register() один раз при
// старте инстанса (Railway — один инстанс, дублей поллера нет).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // WhatsApp-канал работает только через Green API. Фоновые задачи
    // amoCRM удалены вместе с интеграцией — раньше они и так не стартовали
    // (AMOCRM_CHANNEL_ENABLED в проде не задавался), иначе на одно входящее
    // отвечали бы оба канала и клиент получал бы дубли.
    const { startCampaignScheduler } = await import('@/lib/campaigns/scheduler')
    startCampaignScheduler()
    const { startFollowupScheduler } = await import('@/lib/greenapi/followup-scheduler')
    startFollowupScheduler()
    const { startControlCenterHeartbeat } = await import('@/lib/control-center-heartbeat')
    startControlCenterHeartbeat()
    const { startStaffReplyReminders } = await import('@/lib/staff/reminders')
    startStaffReplyReminders()
  }
}
