-- ============================================================
-- integrations.paused_until: временная пауза бота без полного отключения.
--
-- Аварийный выключатель is_active=false требует ручного возврата
-- (src/actions/amocrm-bot.ts). paused_until добавляет авто-резюм: бот
-- молчит до указанного момента и сам включается на следующем чтении
-- статуса, без фонового джоба — см. src/lib/integration-status.ts
-- (isIntegrationBotEnabled), которым теперь проверяется эффективный
-- статус в src/lib/amocrm/bot-reply.ts и src/lib/greenapi/bot-reply.ts.
-- ============================================================

ALTER TABLE public.integrations
  ADD COLUMN paused_until TIMESTAMPTZ;
