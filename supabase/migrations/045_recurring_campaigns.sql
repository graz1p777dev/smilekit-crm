-- Автоматические рассылки: одна настройка, которая сама создаёт обычную
-- рассылку каждые N дней в заданное время.
--
-- Сами отправки по-прежнему живут в campaigns/campaign_recipients — так
-- история, прогресс и остановка работают для автоматических так же, как для
-- ручных. Здесь только правило повторения.

CREATE TABLE IF NOT EXISTS public.recurring_campaigns (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  title         VARCHAR(160) NOT NULL,
  message       TEXT,
  -- id голосового из src/config/voice-messages.ts
  voice_id      TEXT,
  audience      TEXT         NOT NULL DEFAULT 'not_purchased',

  -- Период повторения в днях: 1 — каждый день, 2 — через день.
  interval_days INTEGER      NOT NULL DEFAULT 1,
  -- Время отправки по Бишкеку.
  send_at_time  TIME         NOT NULL,
  -- За сколько последних дней брать клиентов по последнему их сообщению.
  -- NULL — без фильтра по дате, 1 — «только сегодняшние».
  window_days   INTEGER,

  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by    UUID         REFERENCES public.employees(id) ON DELETE SET NULL,
  -- Когда правило отработало в последний раз — защита от повторного запуска
  -- в тот же день и основа расчёта следующего.
  last_run_at   TIMESTAMPTZ,

  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,

  CONSTRAINT recurring_title_check    CHECK (btrim(title) <> ''),
  CONSTRAINT recurring_interval_check CHECK (interval_days BETWEEN 1 AND 30),
  CONSTRAINT recurring_window_check   CHECK (window_days IS NULL OR window_days BETWEEN 1 AND 365),
  CONSTRAINT recurring_audience_check CHECK (audience IN ('not_purchased','purchased','all')),
  -- Как и у обычной рассылки: либо текст, либо голосовое.
  CONSTRAINT recurring_content_check  CHECK (
    (message IS NOT NULL AND char_length(btrim(message)) BETWEEN 1 AND 4000)
    OR (voice_id IS NOT NULL AND btrim(coalesce(voice_id, '')) <> '')
  )
);

CREATE INDEX IF NOT EXISTS idx_recurring_active ON public.recurring_campaigns(is_active) WHERE deleted_at IS NULL;

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

-- Отметка на обычной рассылке: какое правило её породило. NULL — её завели
-- руками. По ней история отличает автоматические от ручных.
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS recurring_id UUID REFERENCES public.recurring_campaigns(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
