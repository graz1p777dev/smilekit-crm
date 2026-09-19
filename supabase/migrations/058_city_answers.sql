-- ============================================================================
-- 058 · Ответы клиентов на вопрос бота о городе
--
-- Чаты, где бот спросил город (метка ga:claim:city-wait:%) в периоде.
-- rows[] — [chat_id, первое сообщение клиента после метки (до 200 символов)
--           или null, купил 0/1]. Купил — заказ (не отменён, не удалён) с
--           номера после вопроса о городе, до сейчас.
-- Город по тексту распознаёт TypeScript (src/lib/analytics/city.ts) — в
-- deals ничего не пишется.
-- Лид — chat_id из цифр, не lab, не телефон сотрудника.
-- Идемпотентна.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.analytics_city_answers(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH asked AS (
  SELECT m.chat_id, min(m.created_at) AS at
  FROM chat_messages m
  WHERE m.amo_message_id LIKE 'ga:claim:city-wait:%'
    AND m.created_at >= p_from AND m.created_at < p_to
    AND m.chat_id ~ '^[0-9]{9,}$' AND m.chat_id NOT LIKE 'lab%'
    AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE right(s.phone, 9) = right(m.chat_id, 9))
  GROUP BY m.chat_id
)
SELECT coalesce(jsonb_agg(jsonb_build_array(
  a.chat_id,
  (SELECT left(m.text, 200) FROM chat_messages m
    WHERE m.chat_id = a.chat_id AND m.sender = 'client' AND m.created_at > a.at
    ORDER BY m.created_at, m.id LIMIT 1),
  EXISTS (SELECT 1 FROM orders o
          WHERE o.deleted_at IS NULL AND o.status <> 'cancelled'
            AND analytics_phone_tail(o.customer_phone) = right(a.chat_id, 9)
            AND o.created_at > a.at)::int
)), '[]'::jsonb)
FROM asked a
$$;

REVOKE ALL ON FUNCTION public.analytics_city_answers(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_city_answers(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
