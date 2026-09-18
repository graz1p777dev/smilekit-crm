-- ============================================================================
-- 049 · Аналитика: передача от бота, скорость ответа, воронка сделок, рассылки
--
-- Те же правила, что в 048: вид сообщения — analytics_msg_kind, лид WhatsApp —
-- chat_id из цифр, не телефон сотрудника; заказ ↔ чат — по последним 9 цифрам.
--
-- Служебные метки бота в chat_messages (amo_message_id, по одной на чат):
--   ga:claim:handed-off:<chat>   передан менеджеру (карточка в группу
--                                «Передача от бота»); created_at сдвигается,
--                                если через сутки без ответа ушла повторная
--                                карточка — это момент ПОСЛЕДНЕЙ карточки;
--   ga:claim:results:<chat>      отправлен блок результата (фото до/после);
--   ga:claim:city-wait:<chat>    бот спросил город;
--   ga:claim:discount13 / discount20  названа скидка;
--   ga:claim:cod-wait            предложена оплата при получении;
--   ga:claim:order-placed        заказ оформлен ботом.
-- Идемпотентна.
-- ============================================================================

-- ─── Бот и передача менеджеру ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.analytics_bot(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH wrote AS (
  SELECT m.chat_id, min(m.created_at) AS first_in_period
  FROM chat_messages m
  WHERE m.sender = 'client'
    AND m.created_at >= p_from AND m.created_at < p_to
    AND m.chat_id ~ '^[0-9]{9,}$' AND m.chat_id NOT LIKE 'lab%'
    AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE right(s.phone, 9) = right(m.chat_id, 9))
  GROUP BY m.chat_id
),
ord AS (
  SELECT analytics_phone_tail(o.customer_phone) AS tail, o.created_at
  FROM orders o
  WHERE o.deleted_at IS NULL AND o.status <> 'cancelled'
    AND analytics_phone_tail(o.customer_phone) <> ''
),
per AS MATERIALIZED (
  SELECT w.chat_id, w.first_in_period,
    (SELECT min(m.created_at) FROM chat_messages m
      WHERE m.chat_id = w.chat_id AND m.created_at > w.first_in_period
        AND analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) = 'b') AS first_bot,
    (SELECT min(m.created_at) FROM chat_messages m
      WHERE m.chat_id = w.chat_id AND m.created_at > w.first_in_period
        AND analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) = 'h') AS first_human,
    (SELECT m.created_at FROM chat_messages m
      WHERE m.amo_message_id = 'ga:claim:handed-off:' || w.chat_id) AS handed_at,
    (SELECT min(o.created_at) FROM ord o
      WHERE o.tail = right(w.chat_id, 9) AND o.created_at > w.first_in_period) AS first_order
  FROM wrote w
),
handed AS (
  SELECT p.*,
    (SELECT min(m.created_at) FROM chat_messages m
      WHERE m.chat_id = p.chat_id AND m.created_at > p.handed_at
        AND analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) = 'h') AS human_after_handoff,
    (SELECT min(o.created_at) FROM ord o
      WHERE o.tail = right(p.chat_id, 9) AND o.created_at > p.handed_at) AS order_after_handoff
  FROM per p
  WHERE p.handed_at >= p_from AND p.handed_at < p_to
),
bot_only AS (
  -- Бот вёл сам: не передан (метки нет вовсе) и человек не писал после
  -- первого сообщения клиента в периоде.
  SELECT * FROM per WHERE handed_at IS NULL AND first_human IS NULL
),
steps AS (
  SELECT split_part(m.amo_message_id, ':', 3) AS k, count(DISTINCT m.chat_id) AS chats
  FROM chat_messages m
  WHERE m.amo_message_id LIKE 'ga:claim:%'
    AND m.created_at >= p_from AND m.created_at < p_to
    AND m.chat_id ~ '^[0-9]{9,}$'
  GROUP BY 1
),
qr AS (
  SELECT count(DISTINCT m.chat_id) AS chats
  FROM chat_messages m
  WHERE m.sender = 'bot' AND m.text = '[QR оплаты]'
    AND m.created_at >= p_from AND m.created_at < p_to
),
waiting_top AS (
  SELECT chat_id, handed_at FROM handed
  WHERE human_after_handoff IS NULL
  ORDER BY handed_at DESC
  LIMIT 300
),
names AS (SELECT analytics_chat_names(array_agg(chat_id)) AS n FROM waiting_top),
mins AS (
  SELECT
    extract(epoch FROM (first_bot - first_in_period)) / 60 AS bot_min,
    extract(epoch FROM (first_human - first_in_period)) / 60 AS human_min,
    extract(epoch FROM (least(first_bot, first_human) - first_in_period)) / 60 AS any_min
  FROM per
),
handoff_mins AS (
  SELECT extract(epoch FROM (human_after_handoff - handed_at)) / 60 AS m
  FROM handed WHERE human_after_handoff IS NOT NULL
)
SELECT jsonb_build_object(
  'wrote', (SELECT count(*) FROM per),
  'handedOff', (SELECT count(*) FROM handed),
  'handedAnswered', (SELECT count(*) FROM handed WHERE human_after_handoff IS NOT NULL),
  'handedWaiting', (SELECT count(*) FROM handed WHERE human_after_handoff IS NULL),
  'handedBought', (SELECT count(*) FROM handed WHERE order_after_handoff IS NOT NULL),
  'handoffMedianMin', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY m) FROM handoff_mins),
  'handoffOver15', (SELECT count(*) FROM handoff_mins WHERE m > 15),
  'handoffOver60', (SELECT count(*) FROM handoff_mins WHERE m > 60),
  'botOnly', (SELECT count(*) FROM bot_only),
  'botOnlyBought', (SELECT count(*) FROM bot_only WHERE first_order IS NOT NULL),
  'steps', coalesce((SELECT jsonb_object_agg(k, chats) FROM steps), '{}'::jsonb),
  'qrSent', (SELECT chats FROM qr),
  'speed', jsonb_build_object(
    'botMedianMin', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY bot_min) FROM mins WHERE bot_min IS NOT NULL),
    'botAnswered', (SELECT count(*) FROM mins WHERE bot_min IS NOT NULL),
    'humanMedianMin', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY human_min) FROM mins WHERE human_min IS NOT NULL),
    'humanAnswered', (SELECT count(*) FROM mins WHERE human_min IS NOT NULL),
    'firstReplyOver15', (SELECT count(*) FROM mins WHERE any_min > 15),
    'noReplyAtAll', (SELECT count(*) FROM mins WHERE any_min IS NULL)
  ),
  'waiting', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'chatId', t.chat_id,
      'handedAt', t.handed_at,
      'name', (SELECT n FROM names) -> t.chat_id ->> 'name',
      'dealId', (SELECT n FROM names) -> t.chat_id ->> 'dealId'
    ) ORDER BY t.handed_at DESC)
    FROM waiting_top t), '[]'::jsonb)
)
$$;

-- ─── Воронка сделок ─────────────────────────────────────────────────────────
-- Сделки, созданные в периоде. «Дошла до этапа» — сделка сейчас на этом
-- этапе или была переведена на него (deal_events.to_stage_id).
CREATE OR REPLACE FUNCTION public.analytics_funnel(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH d AS (
  SELECT id, stage_id, source, nullif(btrim(city), '') AS city
  FROM deals
  WHERE deleted_at IS NULL AND created_at >= p_from AND created_at < p_to
),
reached AS (
  SELECT id AS deal_id, stage_id FROM d
  UNION
  SELECT e.deal_id, e.to_stage_id FROM deal_events e JOIN d ON d.id = e.deal_id
  WHERE e.to_stage_id IS NOT NULL
)
SELECT jsonb_build_object(
  'deals', (SELECT count(*) FROM d),
  'stages', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'name', s.name, 'kind', s.kind, 'isDefault', s.is_default,
      'reached', (SELECT count(DISTINCT r.deal_id) FROM reached r WHERE r.stage_id = s.id),
      'now', (SELECT count(*) FROM d WHERE d.stage_id = s.id)
    ) ORDER BY s.sort_order)
    FROM deal_stages s), '[]'::jsonb),
  'sources', coalesce((
    SELECT jsonb_agg(jsonb_build_object('source', source, 'deals', n) ORDER BY n DESC)
    FROM (SELECT coalesce(source, '') AS source, count(*) AS n FROM d GROUP BY 1) x), '[]'::jsonb),
  'cities', coalesce((
    SELECT jsonb_agg(jsonb_build_object('city', city, 'deals', n) ORDER BY n DESC)
    FROM (SELECT coalesce(city, 'Не указан') AS city, count(*) AS n FROM d GROUP BY 1 ORDER BY 2 DESC LIMIT 20) x), '[]'::jsonb)
)
$$;

-- ─── Рассылки ───────────────────────────────────────────────────────────────
-- Рассылки, начатые (или назначенные) в периоде. Ответили — клиент написал в
-- течение 24 часов после отправки ему; купили — заказ с его номера в течение
-- 7 дней после отправки.
CREATE OR REPLACE FUNCTION public.analytics_campaigns(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH c AS (
  SELECT id, title, status, coalesce(started_at, scheduled_at, created_at) AS at
  FROM campaigns
  WHERE coalesce(started_at, scheduled_at, created_at) >= p_from
    AND coalesce(started_at, scheduled_at, created_at) < p_to
),
r AS (
  SELECT r.campaign_id, r.status, r.chat_id, r.sent_at,
    CASE WHEN r.status = 'sent' AND r.sent_at IS NOT NULL THEN EXISTS (
      SELECT 1 FROM chat_messages m
      WHERE m.chat_id = r.chat_id AND m.sender = 'client'
        AND m.created_at > r.sent_at AND m.created_at < r.sent_at + interval '24 hours'
    ) END AS replied,
    CASE WHEN r.status = 'sent' AND r.sent_at IS NOT NULL THEN EXISTS (
      SELECT 1 FROM orders o
      WHERE o.deleted_at IS NULL AND o.status <> 'cancelled'
        AND analytics_phone_tail(o.customer_phone) = right(r.chat_id, 9)
        AND o.created_at > r.sent_at AND o.created_at < r.sent_at + interval '7 days'
    ) END AS bought
  FROM campaign_recipients r JOIN c ON c.id = r.campaign_id
)
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id', c.id, 'title', c.title, 'status', c.status, 'at', c.at,
  'recipients', (SELECT count(*) FROM r WHERE r.campaign_id = c.id),
  'sent', (SELECT count(*) FROM r WHERE r.campaign_id = c.id AND r.status = 'sent'),
  'failed', (SELECT count(*) FROM r WHERE r.campaign_id = c.id AND r.status = 'failed'),
  'skipped', (SELECT count(*) FROM r WHERE r.campaign_id = c.id AND r.status = 'skipped'),
  'pending', (SELECT count(*) FROM r WHERE r.campaign_id = c.id AND r.status = 'pending'),
  'replied', (SELECT count(*) FROM r WHERE r.campaign_id = c.id AND r.replied),
  'bought', (SELECT count(*) FROM r WHERE r.campaign_id = c.id AND r.bought)
) ORDER BY c.at DESC), '[]'::jsonb)
FROM c
$$;

REVOKE ALL ON FUNCTION public.analytics_bot(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_funnel(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_campaigns(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_bot(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_funnel(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_campaigns(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
