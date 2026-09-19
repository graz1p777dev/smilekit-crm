-- ============================================================================
-- 054 · Воронка бота по новым лидам
--
-- Новый лид периода — чат WhatsApp, где самое первое сообщение клиента
-- пришло в эти дни (как когорта в analytics_leads, 048).
-- Шаги (факты до сейчас, не только внутри периода):
--   botReplied        — сообщение бота после первого сообщения клиента;
--   cityAsked         — метка ga:claim:city-wait:% в чате;
--   cityAnswered      — сообщение клиента после метки city-wait;
--   photoSent         — метка ga:claim:results:% (фото до/после);
--   photoAnswered     — сообщение клиента после метки results;
--   handedOff         — метка ga:claim:handed-off:%;
--   humanAfterHandoff — сообщение человека после метки handed-off
--                       (время метки — последней карточки, см. 049);
--   bought            — заказ (не отменён, не удалён) с номера после первого
--                       сообщения клиента.
-- Возвращаются флаги по каждому лиду битовой маской — порядок воронки и
-- «строгость» (шаг только после всех предыдущих) считает TypeScript.
-- Идемпотентна.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.analytics_bot_lead_funnel(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH new_leads AS (
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
per AS MATERIALIZED (
  SELECT n.chat_id, n.first_client,
    bool_or(analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) = 'b'
            AND m.created_at > n.first_client) AS bot_replied,
    min(m.created_at) FILTER (WHERE m.amo_message_id LIKE 'ga:claim:city-wait:%') AS city_at,
    min(m.created_at) FILTER (WHERE m.amo_message_id LIKE 'ga:claim:results:%') AS photo_at,
    max(m.created_at) FILTER (WHERE m.amo_message_id LIKE 'ga:claim:handed-off:%') AS handed_at
  FROM new_leads n
  JOIN chat_messages m ON m.chat_id = n.chat_id
  GROUP BY n.chat_id, n.first_client
),
ord AS (
  SELECT analytics_phone_tail(o.customer_phone) AS tail, o.created_at
  FROM orders o
  WHERE o.deleted_at IS NULL AND o.status <> 'cancelled'
),
flags AS (
  SELECT p.chat_id,
    1
    | (CASE WHEN p.bot_replied THEN 2 ELSE 0 END)
    | (CASE WHEN p.city_at IS NOT NULL THEN 4 ELSE 0 END)
    | (CASE WHEN p.city_at IS NOT NULL AND EXISTS (
         SELECT 1 FROM chat_messages m WHERE m.chat_id = p.chat_id AND m.sender = 'client'
           AND m.created_at > p.city_at) THEN 8 ELSE 0 END)
    | (CASE WHEN p.photo_at IS NOT NULL THEN 16 ELSE 0 END)
    | (CASE WHEN p.photo_at IS NOT NULL AND EXISTS (
         SELECT 1 FROM chat_messages m WHERE m.chat_id = p.chat_id AND m.sender = 'client'
           AND m.created_at > p.photo_at) THEN 32 ELSE 0 END)
    | (CASE WHEN p.handed_at IS NOT NULL THEN 64 ELSE 0 END)
    | (CASE WHEN p.handed_at IS NOT NULL AND EXISTS (
         SELECT 1 FROM chat_messages m WHERE m.chat_id = p.chat_id
           AND analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) = 'h'
           AND m.created_at > p.handed_at) THEN 128 ELSE 0 END)
    | (CASE WHEN EXISTS (
         SELECT 1 FROM ord o WHERE o.tail = right(p.chat_id, 9) AND o.created_at > p.first_client)
       THEN 256 ELSE 0 END) AS f
  FROM per p
)
SELECT jsonb_build_object(
  'leads', (SELECT count(*) FROM new_leads),
  -- Сколько лидов с каждой комбинацией флагов: {маска: число}.
  'masks', coalesce((SELECT jsonb_object_agg(f, n) FROM (SELECT f, count(*) AS n FROM flags GROUP BY f) x), '{}'::jsonb)
)
$$;

REVOKE ALL ON FUNCTION public.analytics_bot_lead_funnel(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_bot_lead_funnel(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
