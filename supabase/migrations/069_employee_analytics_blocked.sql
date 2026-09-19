-- 069 · Запрет аналитики для отдельного сотрудника.
--
-- Роль задаёт права целиком; иногда нужно отнять один раздел, не меняя роль.
-- Первый случай — служебная учётная запись «ИИ Рассылщик»: рассылки и
-- выключатель бота ей нужны, аналитика — нет (решение владельца 20.09.2026).
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS analytics_blocked BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.employees SET analytics_blocked = TRUE
WHERE user_id = (SELECT id FROM auth.users WHERE lower(email) = 'chatgpt@chatgpt.com');

NOTIFY pgrst, 'reload schema';
