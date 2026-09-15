-- Шаг 2: убрать совместимые представления. Выполнять ТОЛЬКО после того,
-- как задеплоен код, работающий с chat_messages / chat_control.
DROP VIEW IF EXISTS public.amocrm_messages;
DROP VIEW IF EXISTS public.amocrm_chat_control;

NOTIFY pgrst, 'reload schema';
