-- 067 · Автоматические рассылки — те же настройки, что у обычной.
--
-- period_mode — как выбирать клиентов по их последнему сообщению:
--   'days'       — за последние window_days суток по Бишкеку (NULL — без
--                  ограничения); так работали все правила до этой миграции;
--   'hours24'    — ровно последние 24 часа от момента запуска;
--   'since_last' — с создания прошлой неотменённой рассылки;
--   'from_date'  — с даты from_date (по Бишкеку) по момент запуска.
-- include_manager_chats / skip_reached_today — как галочки обычной рассылки.
ALTER TABLE public.recurring_campaigns
  ADD COLUMN IF NOT EXISTS period_mode TEXT NOT NULL DEFAULT 'days',
  ADD COLUMN IF NOT EXISTS from_date DATE,
  ADD COLUMN IF NOT EXISTS include_manager_chats BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS skip_reached_today BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.recurring_campaigns DROP CONSTRAINT IF EXISTS recurring_campaigns_period_mode_check;
ALTER TABLE public.recurring_campaigns ADD CONSTRAINT recurring_campaigns_period_mode_check
  CHECK (period_mode IN ('days', 'hours24', 'since_last', 'from_date')
         AND (period_mode <> 'from_date' OR from_date IS NOT NULL));

NOTIFY pgrst, 'reload schema';

-- Оценка аудитории правила: сколько человек получили бы рассылку, если бы
-- она ушла в момент подсчёта. Пересчитывается раз в сутки планировщиком и
-- по кнопке «Обновить» — живой подсчёт на каждый показ страницы не нужен.
ALTER TABLE public.recurring_campaigns
  ADD COLUMN IF NOT EXISTS audience_estimate INTEGER,
  ADD COLUMN IF NOT EXISTS audience_estimated_at TIMESTAMPTZ;

NOTIFY pgrst, 'reload schema';
