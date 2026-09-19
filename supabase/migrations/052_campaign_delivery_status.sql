-- 052 · Доставлено / прочитано по рассылкам.
--
-- Green API присылает вебхук outgoingMessageStatus на каждое наше сообщение
-- (sent → delivered → read). Раньше id сообщения у получателя рассылки не
-- хранился, и статус было не к чему привязать.
ALTER TABLE public.campaign_recipients
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_provider_message
  ON public.campaign_recipients (provider_message_id) WHERE provider_message_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
