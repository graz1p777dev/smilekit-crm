-- Журнал событий бота (WhatsApp/Instagram): приём, вызов движка, отправка,
-- повторы, восстановление. Хранится 3 суток — чистит followup-scheduler.
CREATE TABLE IF NOT EXISTS public.bot_event_log (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  channel     text NOT NULL DEFAULT 'whatsapp',
  chat_id     text,
  event       text NOT NULL,
  level       text NOT NULL DEFAULT 'info',
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS bot_event_log_created_idx ON public.bot_event_log (created_at DESC);
CREATE INDEX IF NOT EXISTS bot_event_log_chat_idx ON public.bot_event_log (chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bot_event_log_problems_idx ON public.bot_event_log (created_at DESC) WHERE level <> 'info';
ALTER TABLE public.bot_event_log ENABLE ROW LEVEL SECURITY;
