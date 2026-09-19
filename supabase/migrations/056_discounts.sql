-- ============================================================================
-- 056 · Скидки бота и покупки
--
-- Метки бота ga:claim:discount13:% и ga:claim:discount20:% — бот назвал
-- клиенту скидку этой ступени (по одной метке на чат).
--   d13 / d20      — чаты, где метка поставлена в периоде; купил — заказ
--                    (не отменён, не удалён) с номера ПОСЛЕ метки, до сейчас;
--   anyDiscount    — чаты хотя бы с одной такой меткой в периоде; купил —
--                    заказ после первой из меток;
--   newNoDiscount  — новые лиды периода (первое сообщение клиента в эти дни),
--                    которым скидку не называли ни разу; купил — заказ после
--                    первого сообщения клиента;
--   newDiscount    — новые лиды периода, которым скидку назвали (когда
--                    угодно); купил — заказ после первой метки скидки.
-- Лид — chat_id из цифр, не lab, не телефон сотрудника.
-- Идемпотентна.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.analytics_discounts(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH ord AS (
  SELECT analytics_phone_tail(o.customer_phone) AS tail, o.created_at
  FROM orders o
  WHERE o.deleted_at IS NULL AND o.status <> 'cancelled'
),
marks AS MATERIALIZED (
  SELECT m.chat_id, split_part(m.amo_message_id, ':', 3) AS k, min(m.created_at) AS at
  FROM chat_messages m
  WHERE (m.amo_message_id LIKE 'ga:claim:discount13:%' OR m.amo_message_id LIKE 'ga:claim:discount20:%')
    AND m.chat_id ~ '^[0-9]{9,}$' AND m.chat_id NOT LIKE 'lab%'
    AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE right(s.phone, 9) = right(m.chat_id, 9))
  GROUP BY m.chat_id, split_part(m.amo_message_id, ':', 3)
),
first_mark AS (
  SELECT chat_id, min(at) AS at FROM marks GROUP BY chat_id
),
in_period AS (
  SELECT k, chat_id, at FROM marks WHERE at >= p_from AND at < p_to
  UNION ALL
  SELECT 'any', chat_id, at FROM first_mark
  WHERE chat_id IN (SELECT chat_id FROM marks WHERE at >= p_from AND at < p_to)
),
in_period_b AS (
  SELECT i.k, i.chat_id,
    EXISTS (SELECT 1 FROM ord o WHERE o.tail = right(i.chat_id, 9) AND o.created_at > i.at) AS bought
  FROM in_period i
),
new_leads AS (
  SELECT m.chat_id, min(m.created_at) AS first_client
  FROM chat_messages m
  WHERE m.sender = 'client'
    AND m.chat_id ~ '^[0-9]{9,}$' AND m.chat_id NOT LIKE 'lab%'
    AND m.chat_id IN (SELECT chat_id FROM chat_messages
                      WHERE sender = 'client' AND created_at >= p_from AND created_at < p_to)
    AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE right(s.phone, 9) = right(m.chat_id, 9))
  GROUP BY m.chat_id
  HAVING min(m.created_at) >= p_from AND min(m.created_at) < p_to
),
new_b AS (
  SELECT n.chat_id, fm.at IS NOT NULL AS disc,
    EXISTS (SELECT 1 FROM ord o WHERE o.tail = right(n.chat_id, 9)
              AND o.created_at > coalesce(fm.at, n.first_client)) AS bought
  FROM new_leads n LEFT JOIN first_mark fm ON fm.chat_id = n.chat_id
)
SELECT jsonb_build_object(
  'd13', jsonb_build_object('clients', (SELECT count(*) FROM in_period_b WHERE k = 'discount13'),
                            'bought', (SELECT count(*) FROM in_period_b WHERE k = 'discount13' AND bought)),
  'd20', jsonb_build_object('clients', (SELECT count(*) FROM in_period_b WHERE k = 'discount20'),
                            'bought', (SELECT count(*) FROM in_period_b WHERE k = 'discount20' AND bought)),
  'anyDiscount', jsonb_build_object('clients', (SELECT count(*) FROM in_period_b WHERE k = 'any'),
                                    'bought', (SELECT count(*) FROM in_period_b WHERE k = 'any' AND bought)),
  'newNoDiscount', jsonb_build_object('clients', (SELECT count(*) FROM new_b WHERE NOT disc),
                                      'bought', (SELECT count(*) FROM new_b WHERE NOT disc AND bought)),
  'newDiscount', jsonb_build_object('clients', (SELECT count(*) FROM new_b WHERE disc),
                                    'bought', (SELECT count(*) FROM new_b WHERE disc AND bought))
)
$$;

REVOKE ALL ON FUNCTION public.analytics_discounts(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_discounts(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
