-- ============================================================================
-- 053 · «Почти купили»: готовность к оплате без заказа
--
-- Сигнал готовности в периоде — одно из:
--   qr    — бот отправил QR оплаты (сообщение бота с text = '[QR оплаты]');
--   cod   — бот предложил оплату при получении (метка ga:claim:cod-wait:%);
--   ready — сделку перевели на этап «Готов к покупке» (deal_events.to_stage_id).
-- Клиент — последние 9 цифр номера (как заказ ↔ чат в 048). Лид WhatsApp:
-- chat_id из цифр, не lab, не телефон сотрудника.
-- «Почти купил» — после ПЕРВОГО сигнала в периоде заказа (не отменён, не
-- удалён) с этого номера нет до сейчас. Заказ, созданный за час до сигнала
-- и позже, тоже считается «купил»: бот иногда переводит сделку на этап через
-- минуту-другую после заказа.
-- Идемпотентна.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.analytics_almost_bought(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH sig AS (
  SELECT m.chat_id, 'qr'::text AS kind, m.created_at AS at, NULL::uuid AS deal_id
  FROM chat_messages m
  WHERE m.sender = 'bot' AND m.text = '[QR оплаты]'
    AND m.created_at >= p_from AND m.created_at < p_to
  UNION ALL
  SELECT m.chat_id, 'cod', m.created_at, NULL
  FROM chat_messages m
  WHERE m.amo_message_id LIKE 'ga:claim:cod-wait:%'
    AND m.created_at >= p_from AND m.created_at < p_to
  UNION ALL
  SELECT CASE WHEN d.external_key ~ '^greenapi:[0-9]+$' THEN substr(d.external_key, 10)
              ELSE regexp_replace(coalesce(d.customer_phone, ''), '\D', '', 'g') END,
         'ready', e.created_at, d.id
  FROM deal_events e
  JOIN deal_stages s ON s.id = e.to_stage_id AND s.name = 'Готов к покупке'
  JOIN deals d ON d.id = e.deal_id AND d.deleted_at IS NULL
  WHERE e.created_at >= p_from AND e.created_at < p_to
),
lead_sig AS (
  SELECT sig.*, right(sig.chat_id, 9) AS tail
  FROM sig
  WHERE sig.chat_id ~ '^[0-9]{9,}$'
    AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE right(s.phone, 9) = right(sig.chat_id, 9))
),
per AS (
  SELECT tail,
    min(at) AS first_at,
    max(at) AS last_at,
    (array_agg(chat_id ORDER BY at DESC))[1] AS chat_id,
    (array_agg(deal_id ORDER BY at DESC) FILTER (WHERE deal_id IS NOT NULL))[1] AS deal_id,
    max(at) FILTER (WHERE kind = 'qr') AS qr_at,
    max(at) FILTER (WHERE kind = 'cod') AS cod_at,
    max(at) FILTER (WHERE kind = 'ready') AS ready_at
  FROM lead_sig
  GROUP BY tail
),
ord AS (
  SELECT analytics_phone_tail(o.customer_phone) AS tail, o.created_at
  FROM orders o
  WHERE o.deleted_at IS NULL AND o.status <> 'cancelled'
),
almost AS (
  SELECT p.* FROM per p
  WHERE NOT EXISTS (SELECT 1 FROM ord o WHERE o.tail = p.tail AND o.created_at > p.first_at - interval '1 hour')
),
last_msg AS (
  SELECT a.tail, lm.k, lm.created_at
  FROM almost a
  LEFT JOIN LATERAL (
    SELECT analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) AS k, m.created_at
    FROM chat_messages m
    WHERE m.chat_id = a.chat_id
      AND analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) IS NOT NULL
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) lm ON true
),
names AS (SELECT analytics_chat_names(array_agg(chat_id)) AS n FROM almost)
SELECT jsonb_build_object(
  'signaled', (SELECT count(*) FROM per),
  'bought', (SELECT count(*) FROM per) - (SELECT count(*) FROM almost),
  'almost', (SELECT count(*) FROM almost),
  'byKind', jsonb_build_object(
    'qr', (SELECT count(*) FROM almost WHERE qr_at IS NOT NULL),
    'cod', (SELECT count(*) FROM almost WHERE cod_at IS NOT NULL),
    'ready', (SELECT count(*) FROM almost WHERE ready_at IS NOT NULL)
  ),
  'signaledByKind', jsonb_build_object(
    'qr', (SELECT count(*) FROM per WHERE qr_at IS NOT NULL),
    'cod', (SELECT count(*) FROM per WHERE cod_at IS NOT NULL),
    'ready', (SELECT count(*) FROM per WHERE ready_at IS NOT NULL)
  ),
  'rows', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'chatId', a.chat_id,
      'name', coalesce(dd.customer_name, (SELECT n FROM names) -> a.chat_id ->> 'name'),
      'dealId', coalesce(a.deal_id::text, (SELECT n FROM names) -> a.chat_id ->> 'dealId'),
      'qrAt', a.qr_at, 'codAt', a.cod_at, 'readyAt', a.ready_at,
      'lastSignalAt', a.last_at,
      'lastBy', lm.k, 'lastMsgAt', lm.created_at
    ) ORDER BY a.last_at DESC)
    FROM almost a
    JOIN last_msg lm ON lm.tail = a.tail
    LEFT JOIN deals dd ON dd.id = a.deal_id), '[]'::jsonb)
)
$$;

REVOKE ALL ON FUNCTION public.analytics_almost_bought(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_almost_bought(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
