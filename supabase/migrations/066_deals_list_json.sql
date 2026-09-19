-- ============================================================================
-- 066 · Все живые сделки одним запросом (доска сделок, страница клиентов)
--
-- PostgREST отдаёт не больше 1000 строк, поэтому доска (getDealsData в
-- src/actions/deals.ts) и страница «Клиенты» читали сделки постранично:
-- 13 последовательных запросов ORDER BY created_at DESC OFFSET n. Каждый
-- из них заново проверял RLS (can_see_deal → get_my_role() на каждой
-- строке) по всей таблице и сортировал её — на проде ~0,3 с на страницу,
-- ~4 с только в базе на одно открытие доски.
--
-- Здесь та же выборка (deleted_at IS NULL, тот же порядок) одним проходом.
-- SECURITY INVOKER: видимость по-прежнему решает RLS вызывающего, как и при
-- обычном select. Результат — один JSON, на него лимит в 1000 строк не
-- действует.
--   p_compact = false — колонки доски (DEAL_BOARD_COLUMNS);
--   p_compact = true  — колонки страницы «Клиенты».
-- Идемпотентна.
-- ============================================================================

-- json, а не jsonb: собрать json_agg из строк в ~4 раза быстрее, чем
-- jsonb_build_object на каждую из 12 тыс. строк (0,2 с против 0,9 с).
-- (Черновой вариант этой функции с jsonb — public.deals_list(boolean) — успел
-- попасть на прод 19.09 и не используется; удалить: DROP FUNCTION public.deals_list(boolean).)
-- Ветка по p_compact — отдельные подзапросы: считается только нужный.
CREATE OR REPLACE FUNCTION public.deals_list_json(p_compact BOOLEAN)
RETURNS JSON
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
SELECT CASE WHEN p_compact THEN (
  SELECT coalesce(json_agg(c ORDER BY c.created_at DESC), '[]'::json)
  FROM (
    SELECT id, customer_name, customer_phone, customer_username, city, source, created_at
    FROM deals WHERE deleted_at IS NULL
  ) c
) ELSE (
  SELECT coalesce(json_agg(f ORDER BY f.created_at DESC), '[]'::json)
  FROM (
    SELECT id, title, stage_id, amount, currency, customer_name, customer_phone,
      customer_username, city, address, source, external_key, responsible_employee_id,
      note, status, stage_changed_at, created_at, updated_at
    FROM deals WHERE deleted_at IS NULL
  ) f
) END
$$;

REVOKE ALL ON FUNCTION public.deals_list_json(BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deals_list_json(BOOLEAN) TO authenticated, service_role;
