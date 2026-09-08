// Фоновые задачи сервера CRM. Next.js вызывает register() один раз при
// старте инстанса (Railway — один инстанс, дублей поллера нет).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // WhatsApp-канал переехал с amoCRM/WhatCRM на Green API. Пока
    // AMOCRM_CHANNEL_ENABLED !== 'true', фоновые задачи amoCRM не стартуют:
    // иначе на одно входящее сообщение отвечали бы оба канала сразу
    // (один и тот же номер), и клиент получал бы дубли.
    if (process.env.AMOCRM_CHANNEL_ENABLED === 'true') {
      const { startAmoOutgoingPoller } = await import('@/lib/amocrm/outgoing-poller')
      startAmoOutgoingPoller()
      const { replayRecentUnansweredAmoMessages } = await import('@/lib/amocrm/bot-reply')
      void replayRecentUnansweredAmoMessages().catch((error) =>
        console.error('amocrm unanswered replay failed', error)
      )
    }
    const { startCampaignScheduler } = await import('@/lib/campaigns/scheduler')
    startCampaignScheduler()
    const { startFollowupScheduler } = await import('@/lib/greenapi/followup-scheduler')
    startFollowupScheduler()
    const { startControlCenterHeartbeat } = await import('@/lib/control-center-heartbeat')
    startControlCenterHeartbeat()
  }
}
