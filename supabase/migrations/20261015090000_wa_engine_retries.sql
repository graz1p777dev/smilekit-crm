-- Очередь повторов для входящих, на которые движок бота (/internal/wa/handle)
-- не ответил (504/502). Без неё такое сообщение терялось навсегда: клиент
-- ждал ответа, а вебхук повторно не приходит. Повторы делает followup-scheduler
-- после того, как движок снова отвечает на /tick.
CREATE TABLE IF NOT EXISTS public.wa_engine_retries (
  message_id   text PRIMARY KEY,
  chat_id      text NOT NULL,
  kind         text NOT NULL,
  text         text NOT NULL DEFAULT '',
  media_url    text,
  seed         jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  next_try_at  timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wa_engine_retries_pending_idx
  ON public.wa_engine_retries (next_try_at) WHERE done_at IS NULL;
ALTER TABLE public.wa_engine_retries ENABLE ROW LEVEL SECURITY;
