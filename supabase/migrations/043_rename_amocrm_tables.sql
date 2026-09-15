-- Переименование наследия amoCRM. Канал давно один — Green API (WhatsApp),
-- а имена таблиц и строка выключателя остались от старой интеграции.
--
-- Применяется В ДВА ШАГА, чтобы не потерять входящие сообщения.
-- Шаг 1 (этот файл) выполняется ДО деплоя нового кода: таблицы получают новые
-- имена, а под старыми остаются представления, через которые продолжает
-- работать уже задеплоенный код. Ничего не простаивает.
--
-- Шаг 2 (044_drop_amocrm_compat_views.sql) удаляет представления — уже
-- ПОСЛЕ деплоя.

-- Идемпотентно: в проде переименование уже применено вручную 2026-09-14,
-- повторный прогон (например, supabase db push) не должен падать.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='amocrm_messages') THEN
    ALTER TABLE public.amocrm_messages RENAME TO chat_messages;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='amocrm_chat_control') THEN
    ALTER TABLE public.amocrm_chat_control RENAME TO chat_control;
  END IF;
END $$;

-- Выключатель WhatsApp-бота. Шлюз ответа считает отсутствие строки за
-- «бот выключен», поэтому имя меняем, а не пересоздаём.
UPDATE public.integrations SET name = 'whatsapp' WHERE name = 'amoCRM';

-- Совместимость на время деплоя. security_invoker сохраняет поведение RLS:
-- без него представление читалось бы правами владельца, в обход политик.
CREATE OR REPLACE VIEW public.amocrm_messages WITH (security_invoker = true) AS
  SELECT * FROM public.chat_messages;
CREATE OR REPLACE VIEW public.amocrm_chat_control WITH (security_invoker = true) AS
  SELECT * FROM public.chat_control;

GRANT SELECT ON public.amocrm_messages     TO authenticated;
GRANT SELECT ON public.amocrm_chat_control TO authenticated;
GRANT ALL    ON public.amocrm_messages     TO service_role;
GRANT ALL    ON public.amocrm_chat_control TO service_role;

-- PostgREST кеширует схему; после DDL просим перечитать.
NOTIFY pgrst, 'reload schema';
