-- ============================================================================
-- Все незавершённые миграции одним блоком — для ручного запуска в
-- Supabase → SQL Editor. Лежит ВНЕ supabase/migrations/, чтобы supabase db push
-- не принял его за очередную миграцию. БЕЗОПАСНО запускать повторно:
-- каждый шаг сам проверяет, сделан ли он уже, и пропускает сделанное.
-- Порядок важен и уже выставлен.
-- ============================================================================

-- ─── 042 · Голосовые рассылки ───────────────────────────────────────────────
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS voice_id TEXT;
ALTER TABLE public.campaigns ALTER COLUMN message DROP NOT NULL;
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_message_check;
ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_message_check CHECK (
  (message IS NOT NULL AND char_length(btrim(message)) BETWEEN 1 AND 4000)
  OR (voice_id IS NOT NULL AND btrim(coalesce(voice_id, '')) <> '')
);

-- ─── 043 · Переименование наследия amoCRM ───────────────────────────────────
-- Переименовываем только если под старым именем всё ещё ТАБЛИЦА.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='amocrm_messages') THEN
    ALTER TABLE public.amocrm_messages RENAME TO chat_messages;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='amocrm_chat_control') THEN
    ALTER TABLE public.amocrm_chat_control RENAME TO chat_control;
  END IF;
END $$;

UPDATE public.integrations SET name = 'whatsapp' WHERE name = 'amoCRM';

-- ─── 044 · Временные представления больше не нужны ──────────────────────────
-- Код CRM уже работает с новыми именами — старые имена можно убрать.
DROP VIEW IF EXISTS public.amocrm_messages;
DROP VIEW IF EXISTS public.amocrm_chat_control;

-- ─── 045 · Автоматические рассылки ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recurring_campaigns (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  title         VARCHAR(160) NOT NULL,
  message       TEXT,
  voice_id      TEXT,
  audience      TEXT         NOT NULL DEFAULT 'not_purchased',
  interval_days INTEGER      NOT NULL DEFAULT 1,
  send_at_time  TIME         NOT NULL,
  window_days   INTEGER,
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by    UUID         REFERENCES public.employees(id) ON DELETE SET NULL,
  last_run_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  CONSTRAINT recurring_title_check    CHECK (btrim(title) <> ''),
  CONSTRAINT recurring_interval_check CHECK (interval_days BETWEEN 1 AND 30),
  CONSTRAINT recurring_window_check   CHECK (window_days IS NULL OR window_days BETWEEN 1 AND 365),
  CONSTRAINT recurring_audience_check CHECK (audience IN ('not_purchased','purchased','all')),
  CONSTRAINT recurring_content_check  CHECK (
    (message IS NOT NULL AND char_length(btrim(message)) BETWEEN 1 AND 4000)
    OR (voice_id IS NOT NULL AND btrim(coalesce(voice_id, '')) <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_recurring_active
  ON public.recurring_campaigns(is_active) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS set_recurring_campaigns_updated_at ON public.recurring_campaigns;
CREATE TRIGGER set_recurring_campaigns_updated_at
  BEFORE UPDATE ON public.recurring_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.recurring_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "recurring_campaigns_select" ON public.recurring_campaigns;
CREATE POLICY "recurring_campaigns_select" ON public.recurring_campaigns
  FOR SELECT TO authenticated
  USING (public.get_my_role() IN ('owner','rop'));

GRANT SELECT ON public.recurring_campaigns TO authenticated;
GRANT ALL    ON public.recurring_campaigns TO service_role;

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS recurring_id UUID
  REFERENCES public.recurring_campaigns(id) ON DELETE SET NULL;

-- PostgREST кеширует схему — просим перечитать, иначе новые таблицы
-- и колонки какое-то время будут «не найдены».
NOTIFY pgrst, 'reload schema';
