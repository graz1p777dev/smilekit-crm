-- ============================================================================
-- 060 · Чеки и способы оплаты по заказам
--
-- Заказы периода (не удалены, не отменены — как «Покупки» в 048). Вид — по
-- началу orders.summary, которое пишет бот WhatsApp:
--   verified — «Чек проверен (WhatsApp)»                — прошёл автопроверку;
--   unchecked — «Чек не проверен автоматически»          — автопроверки не было;
--   rejected — «Чек не прошёл проверку»                 — автопроверка отклонила;
--   manager  — «Чек об оплате, чат вёл менеджер»        — чек в чате менеджера;
--   cod      — «Оплата при получении»;
--   other    — остальное (заказы Telegram-бота, вручную).
-- По каждому: заказов, сумма (где total_amount указан), с суммой, без суммы.
-- Идемпотентна.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.analytics_receipts(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH o AS (
  SELECT total_amount,
    CASE
      WHEN summary LIKE 'Чек проверен%' THEN 'verified'
      WHEN summary LIKE 'Чек не проверен автоматически%' THEN 'unchecked'
      WHEN summary LIKE 'Чек не прошёл проверку%' THEN 'rejected'
      WHEN summary LIKE 'Чек об оплате, чат вёл менеджер%' THEN 'manager'
      WHEN summary LIKE 'Оплата при получении%' THEN 'cod'
      ELSE 'other'
    END AS kind
  FROM orders
  WHERE deleted_at IS NULL AND status <> 'cancelled'
    AND created_at >= p_from AND created_at < p_to
)
SELECT coalesce(jsonb_object_agg(kind, jsonb_build_object(
  'orders', n, 'sum', s, 'withAmount', wa, 'noAmount', n - wa)), '{}'::jsonb)
FROM (
  SELECT kind, count(*) AS n, coalesce(sum(total_amount), 0) AS s, count(total_amount) AS wa
  FROM o GROUP BY kind
) x
$$;

REVOKE ALL ON FUNCTION public.analytics_receipts(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_receipts(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
