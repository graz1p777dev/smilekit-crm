-- 051 · Длинные отчёты сервера CRM.
--
-- Аналитика «За всё время» (analytics_leads) идёт ~12 с, а у ролей API лимит
-- statement_timeout = 8 с — отчёт обрывался «canceling statement due to
-- statement timeout». Поднимаем лимит только для service_role: ею ходит
-- лишь сервер CRM, браузер и боты этой ролью не пользуются.
ALTER ROLE service_role SET statement_timeout = '60s';
NOTIFY pgrst, 'reload config';
