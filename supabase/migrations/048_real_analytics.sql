-- ============================================================================
-- 048 · Реальная аналитика для владельца
--
-- Только факты из базы. SQL отдаёт сырые факты (сколько сообщений, когда
-- что было), пороги «железный/воздухан» живут в одном месте в TypeScript —
-- src/lib/analytics/client-types.ts.
--
-- Классификация сообщений chat_messages — строго по договору:
--   клиент   — sender='client'
--   человек  — sender='operator' и author_name не маркер массовой рассылки
--   бот      — sender='bot', кроме служебных ga:claim:% и рассылок campaign:%
--   остальное (рассылки, якоря) — не часть диалога.
-- Лид WhatsApp = chat_id только цифры (9+), не lab…, не телефон сотрудника.
-- Телефон заказа ↔ чат — по последним 9 цифрам.
--
-- Все функции SECURITY INVOKER, вызываются только сервером (service_role).
-- Идемпотентна.
-- ============================================================================

-- Вид сообщения: 'c' клиент, 'h' человек, 'b' бот, NULL — не часть диалога.
CREATE OR REPLACE FUNCTION public.analytics_msg_kind(p_sender TEXT, p_author TEXT, p_amo_id TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_sender = 'client' THEN 'c'
    WHEN p_sender = 'operator'
         AND p_author IS DISTINCT FROM '[система: похоже на массовую рассылку]' THEN 'h'
    WHEN p_sender = 'bot'
         AND p_amo_id NOT LIKE 'ga:claim:%'
         AND p_amo_id NOT LIKE 'campaign:%' THEN 'b'
  END
$$;

-- Последние 9 цифр телефона ('' если цифр нет).
CREATE OR REPLACE FUNCTION public.analytics_phone_tail(p_phone TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9)
$$;

CREATE INDEX IF NOT EXISTS idx_deals_phone_tail
  ON public.deals (right(regexp_replace(coalesce(customer_phone, ''), '\D', '', 'g'), 9));

-- Имя и сделка для списка чатов: сначала сделка greenapi:<chat_id>, иначе
-- самая свежая сделка с тем же хвостом телефона.
CREATE OR REPLACE FUNCTION public.analytics_chat_names(p_chat_ids TEXT[])
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_object_agg(x.chat_id, jsonb_build_object('name', x.customer_name, 'dealId', x.id)), '{}'::jsonb)
  FROM (
    SELECT DISTINCT ON (c.chat_id) c.chat_id, d.customer_name, d.id
    FROM unnest(p_chat_ids) AS c(chat_id)
    JOIN public.deals d
      ON d.deleted_at IS NULL
     AND right(regexp_replace(coalesce(d.customer_phone, ''), '\D', '', 'g'), 9) = right(c.chat_id, 9)
    ORDER BY c.chat_id, (d.external_key = 'greenapi:' || c.chat_id) DESC, d.created_at DESC
  ) x
$$;

-- ─── Лиды, конверсия, факты для типов клиентов ──────────────────────────────
--
-- Возвращает:
--   wrote, newLeads, human, botOnly, noReply   — по писавшим за период
--   waitingTotal, waiting[] (до 300, свежие сверху)
--   cohort[] — по новым лидам периода, массивы:
--     [chatId, firstClientMs, firstDialogMs, totalMsgs, humanAfterFirst(0/1),
--      botAfterFirst(0/1), firstOrderMs|null, msgsBeforeOrder|null,
--      humanAfterLastClient(0/1)]
--   dataSince — самое раннее сообщение в базе
CREATE OR REPLACE FUNCTION public.analytics_leads(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
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
dm AS MATERIALIZED (
  SELECT m.id, m.chat_id, m.created_at,
         analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) AS k
  FROM chat_messages m
  JOIN wrote w ON w.chat_id = m.chat_id
  WHERE analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) IS NOT NULL
),
per AS (
  SELECT w.chat_id, w.first_in_period,
    min(dm.created_at) FILTER (WHERE dm.k = 'c') AS first_client,
    min(dm.created_at) AS first_dialog,
    count(*) AS total_msgs,
    max(dm.created_at) FILTER (WHERE dm.k = 'c') AS last_client,
    max(dm.created_at) FILTER (WHERE dm.k IN ('h', 'b')) AS last_reply,
    max(dm.created_at) FILTER (WHERE dm.k = 'h') AS last_human,
    coalesce(bool_or(dm.k = 'h' AND dm.created_at > w.first_in_period), false) AS human_after_first,
    coalesce(bool_or(dm.k = 'b' AND dm.created_at > w.first_in_period), false) AS bot_after_first,
    (array_agg(dm.k ORDER BY dm.created_at DESC, dm.id DESC))[1] AS last_kind,
    (array_agg(dm.id ORDER BY dm.created_at DESC, dm.id DESC) FILTER (WHERE dm.k = 'c'))[1] AS last_client_id
  FROM wrote w
  JOIN dm ON dm.chat_id = w.chat_id
  GROUP BY w.chat_id, w.first_in_period
),
ord AS (
  SELECT analytics_phone_tail(o.customer_phone) AS tail, o.created_at
  FROM orders o
  WHERE o.deleted_at IS NULL AND o.status <> 'cancelled'
    AND analytics_phone_tail(o.customer_phone) <> ''
),
per2 AS (
  SELECT p.*,
    (SELECT min(o.created_at) FROM ord o
      WHERE o.tail = right(p.chat_id, 9) AND o.created_at > p.first_client) AS first_order
  FROM per p
),
-- Второй проход по сообщениям: то, что зависит от итогов первого.
per3 AS (
  SELECT p.chat_id,
    count(*) FILTER (WHERE p.first_order IS NOT NULL AND dm.created_at < p.first_order) AS msgs_before,
    min(dm.created_at) FILTER (WHERE dm.k = 'c'
      AND dm.created_at > coalesce(p.last_reply, '-infinity'::timestamptz)) AS waiting_since
  FROM per2 p
  JOIN dm ON dm.chat_id = p.chat_id
  WHERE (p.first_client >= p_from AND p.first_client < p_to AND p.first_order IS NOT NULL)
     OR p.last_kind = 'c'
  GROUP BY p.chat_id
),
cohort AS (
  SELECT p.*, x.msgs_before
  FROM per2 p LEFT JOIN per3 x ON x.chat_id = p.chat_id
  WHERE p.first_client >= p_from AND p.first_client < p_to
),
waiting_top AS (
  SELECT p.chat_id, p.last_client, x.waiting_since, p.last_client_id
  FROM per2 p JOIN per3 x ON x.chat_id = p.chat_id
  WHERE p.last_kind = 'c'
  ORDER BY p.last_client DESC
  LIMIT 300
),
names AS (
  SELECT analytics_chat_names(array_agg(chat_id)) AS n FROM waiting_top
)
SELECT jsonb_build_object(
  'wrote',    (SELECT count(*) FROM per),
  'newLeads', (SELECT count(*) FROM cohort),
  'human',    (SELECT count(*) FROM per WHERE human_after_first),
  'botOnly',  (SELECT count(*) FROM per WHERE NOT human_after_first AND bot_after_first),
  'noReply',  (SELECT count(*) FROM per WHERE NOT human_after_first AND NOT bot_after_first),
  'waitingTotal', (SELECT count(*) FROM per WHERE last_kind = 'c'),
  'waiting', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'chatId', t.chat_id,
      'since', t.waiting_since,
      'lastAt', t.last_client,
      'lastText', left(coalesce(cmx.text, ''), 140),
      'name', (SELECT n FROM names) -> t.chat_id ->> 'name',
      'dealId', (SELECT n FROM names) -> t.chat_id ->> 'dealId'
    ) ORDER BY t.last_client DESC)
    FROM waiting_top t LEFT JOIN chat_messages cmx ON cmx.id = t.last_client_id), '[]'::jsonb),
  'cohort', coalesce((
    SELECT jsonb_agg(jsonb_build_array(
      r.chat_id,
      floor(extract(epoch FROM r.first_client) * 1000),
      floor(extract(epoch FROM r.first_dialog) * 1000),
      r.total_msgs,
      r.human_after_first::int,
      r.bot_after_first::int,
      floor(extract(epoch FROM r.first_order) * 1000),
      r.msgs_before,
      (r.last_human IS NOT NULL AND r.last_human > r.last_client)::int
    ) ORDER BY r.first_client DESC)
    FROM cohort r), '[]'::jsonb),
  'dataSince', (SELECT min(created_at) FROM chat_messages)
)
$$;

-- ─── Покупки за период ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.analytics_purchases(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH o AS (
  SELECT id, created_at, quantity, total_amount, nullif(btrim(city), '') AS city,
         analytics_phone_tail(customer_phone) AS tail
  FROM orders
  WHERE deleted_at IS NULL AND status <> 'cancelled'
    AND created_at >= p_from AND created_at < p_to
),
all_orders AS (
  SELECT analytics_phone_tail(customer_phone) AS tail, count(*) AS n
  FROM orders
  WHERE deleted_at IS NULL AND status <> 'cancelled' AND created_at < p_to
  GROUP BY 1
)
SELECT jsonb_build_object(
  'orders', (SELECT count(*) FROM o),
  'boxes', (SELECT coalesce(sum(quantity), 0) FROM o),
  'noQuantity', (SELECT count(*) FROM o WHERE quantity IS NULL),
  'revenue', (SELECT coalesce(sum(total_amount), 0) FROM o),
  'withAmount', (SELECT count(*) FROM o WHERE total_amount IS NOT NULL),
  'noAmount', (SELECT count(*) FROM o WHERE total_amount IS NULL),
  'noPhone', (SELECT count(*) FROM o WHERE tail = ''),
  'buyers', (SELECT count(DISTINCT tail) FROM o WHERE tail <> ''),
  'repeatBuyers', (SELECT count(DISTINCT o.tail) FROM o JOIN all_orders a ON a.tail = o.tail
                   WHERE o.tail <> '' AND a.n >= 2),
  'cities', coalesce((
    SELECT jsonb_agg(jsonb_build_object('city', city, 'orders', n) ORDER BY n DESC, city)
    FROM (SELECT coalesce(city, 'Не указан') AS city, count(*) AS n FROM o GROUP BY 1) c), '[]'::jsonb),
  'daily', coalesce((
    SELECT jsonb_agg(jsonb_build_object('day', day, 'orders', n, 'revenue', rev) ORDER BY day)
    FROM (
      SELECT to_char(created_at AT TIME ZONE 'Asia/Bishkek', 'YYYY-MM-DD') AS day,
             count(*) AS n, coalesce(sum(total_amount), 0) AS rev
      FROM o GROUP BY 1
    ) d), '[]'::jsonb)
)
$$;

-- ─── Сотрудники по сменам ───────────────────────────────────────────────────
--
-- Смена засчитывается внутри периода: [max(начало, p_from), min(конец|сейчас, p_to)).
-- Лид смены — чат, где клиент писал внутри смены. Ответил — сообщение
-- человека в этом чате после сообщения клиента и внутри той же смены.
-- «Вне смен» — моменты, когда на смене не было никого.
CREATE OR REPLACE FUNCTION public.analytics_staff(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH sh AS (
  SELECT s.id, s.staff_id, s.mode, s.started_at, s.ended_at,
         coalesce(s.ended_at, now()) AS raw_e,
         greatest(s.started_at, p_from) AS cs,
         least(coalesce(s.ended_at, now()), p_to) AS ce
  FROM staff_shifts s
  WHERE s.started_at < p_to AND coalesce(s.ended_at, now()) > p_from
),
-- Все смены целиком — чтобы проверить «на смене никого», в том числе для
-- ответа, пришедшего после конца периода.
allsh AS (
  SELECT started_at, coalesce(ended_at, now()) AS raw_e FROM staff_shifts
),
cm AS (
  SELECT m.chat_id, m.created_at
  FROM chat_messages m
  WHERE m.sender = 'client'
    AND m.created_at >= p_from AND m.created_at < p_to
    AND m.chat_id ~ '^[0-9]{9,}$' AND m.chat_id NOT LIKE 'lab%'
    AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE right(s.phone, 9) = right(m.chat_id, 9))
),
hm AS (
  SELECT m.chat_id, m.created_at
  FROM chat_messages m
  WHERE m.chat_id IN (SELECT DISTINCT chat_id FROM cm)
    AND analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) = 'h'
),
ord AS (
  SELECT analytics_phone_tail(customer_phone) AS tail, created_at, total_amount
  FROM orders
  WHERE deleted_at IS NULL AND status <> 'cancelled'
),
leads AS (
  SELECT DISTINCT sh.staff_id, cm.chat_id
  FROM cm JOIN sh ON cm.created_at >= sh.cs AND cm.created_at < sh.ce
),
answered AS (
  SELECT sh.staff_id, cm.chat_id, min(hm.created_at) AS first_answer
  FROM cm
  JOIN sh ON cm.created_at >= sh.cs AND cm.created_at < sh.ce
  JOIN hm ON hm.chat_id = cm.chat_id AND hm.created_at > cm.created_at
         AND hm.created_at >= sh.started_at AND hm.created_at < sh.raw_e
  GROUP BY sh.staff_id, cm.chat_id
),
staff_orders AS (
  SELECT sh.staff_id, count(*) AS n, coalesce(sum(o.total_amount), 0) AS rev,
         count(*) FILTER (WHERE o.total_amount IS NULL) AS no_amount
  FROM (SELECT DISTINCT staff_id, cs, ce FROM sh) sh
  JOIN ord o ON o.created_at >= sh.cs AND o.created_at < sh.ce
  GROUP BY sh.staff_id
),
off_leads AS (
  SELECT DISTINCT cm.chat_id FROM cm
  WHERE NOT EXISTS (SELECT 1 FROM allsh sh WHERE cm.created_at >= sh.started_at AND cm.created_at < sh.raw_e)
),
off_answered AS (
  SELECT cm.chat_id, min(hm.created_at) AS first_answer
  FROM cm
  JOIN hm ON hm.chat_id = cm.chat_id AND hm.created_at > cm.created_at
  WHERE NOT EXISTS (SELECT 1 FROM allsh sh WHERE cm.created_at >= sh.started_at AND cm.created_at < sh.raw_e)
    AND NOT EXISTS (SELECT 1 FROM allsh sh WHERE hm.created_at >= sh.started_at AND hm.created_at < sh.raw_e)
  GROUP BY cm.chat_id
),
off_orders AS (
  SELECT count(*) AS n, coalesce(sum(total_amount), 0) AS rev,
         count(*) FILTER (WHERE total_amount IS NULL) AS no_amount
  FROM ord o
  WHERE o.created_at >= p_from AND o.created_at < p_to
    AND NOT EXISTS (SELECT 1 FROM allsh sh WHERE o.created_at >= sh.started_at AND o.created_at < sh.raw_e)
),
unanswered AS (
  SELECT l.staff_id, l.chat_id FROM leads l
  WHERE NOT EXISTS (SELECT 1 FROM answered a WHERE a.staff_id = l.staff_id AND a.chat_id = l.chat_id)
),
off_unanswered AS (
  SELECT l.chat_id FROM off_leads l
  WHERE NOT EXISTS (SELECT 1 FROM off_answered a WHERE a.chat_id = l.chat_id)
),
names AS (
  SELECT analytics_chat_names(array_agg(DISTINCT chat_id)) AS n
  FROM (SELECT chat_id FROM unanswered UNION SELECT chat_id FROM off_unanswered) u
)
SELECT jsonb_build_object(
  'shifts', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'staffId', sh.staff_id, 'name', sm.full_name, 'mode', sh.mode,
      'from', sh.cs, 'to', sh.ce) ORDER BY sh.cs)
    FROM sh JOIN staff_members sm ON sm.id = sh.staff_id), '[]'::jsonb),
  'staff', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'staffId', st.staff_id,
      'leads', (SELECT count(*) FROM leads l WHERE l.staff_id = st.staff_id),
      'answered', (SELECT count(*) FROM answered a WHERE a.staff_id = st.staff_id),
      'boughtAfterAnswer', (SELECT count(*) FROM answered a WHERE a.staff_id = st.staff_id
        AND EXISTS (SELECT 1 FROM ord o WHERE o.tail = right(a.chat_id, 9) AND o.created_at > a.first_answer)),
      'orders', coalesce((SELECT n FROM staff_orders so WHERE so.staff_id = st.staff_id), 0),
      'revenue', coalesce((SELECT rev FROM staff_orders so WHERE so.staff_id = st.staff_id), 0),
      'ordersNoAmount', coalesce((SELECT no_amount FROM staff_orders so WHERE so.staff_id = st.staff_id), 0),
      'unanswered', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'chatId', u.chat_id,
          'name', (SELECT n FROM names) -> u.chat_id ->> 'name',
          'dealId', (SELECT n FROM names) -> u.chat_id ->> 'dealId'))
        FROM (SELECT chat_id FROM unanswered u WHERE u.staff_id = st.staff_id LIMIT 100) u), '[]'::jsonb)
    ))
    FROM (SELECT DISTINCT staff_id FROM sh) st), '[]'::jsonb),
  'offShift', jsonb_build_object(
    'leads', (SELECT count(*) FROM off_leads),
    'answered', (SELECT count(*) FROM off_answered),
    'boughtAfterAnswer', (SELECT count(*) FROM off_answered a
      WHERE EXISTS (SELECT 1 FROM ord o WHERE o.tail = right(a.chat_id, 9) AND o.created_at > a.first_answer)),
    'orders', (SELECT n FROM off_orders),
    'revenue', (SELECT rev FROM off_orders),
    'ordersNoAmount', (SELECT no_amount FROM off_orders),
    'unansweredTotal', (SELECT count(*) FROM off_unanswered),
    'unanswered', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'chatId', u.chat_id,
        'name', (SELECT n FROM names) -> u.chat_id ->> 'name',
        'dealId', (SELECT n FROM names) -> u.chat_id ->> 'dealId'))
      FROM (SELECT chat_id FROM off_unanswered LIMIT 100) u), '[]'::jsonb)
  )
)
$$;

-- ─── Один клиент: факты для типа и «кто обслуживал» ─────────────────────────
--
-- Все лид-чаты с тем же хвостом телефона считаются одним диалогом.
-- served[] — сообщения человека, сгруппированные по составу смены в момент
-- сообщения: {names:[…] (пусто = на смене никого), messages, firstAt, lastAt}.
CREATE OR REPLACE FUNCTION public.analytics_client_facts(p_phone TEXT)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH t AS (SELECT analytics_phone_tail(p_phone) AS tail),
dm AS (
  SELECT m.id, m.chat_id, m.created_at,
         analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) AS k
  FROM chat_messages m, t
  WHERE length(t.tail) = 9
    AND right(m.chat_id, 9) = t.tail
    AND m.chat_id ~ '^[0-9]{9,}$' AND m.chat_id NOT LIKE 'lab%'
    AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE right(s.phone, 9) = t.tail)
    AND analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) IS NOT NULL
),
f AS (
  SELECT min(created_at) FILTER (WHERE k = 'c') AS first_client,
         min(created_at) AS first_dialog,
         count(*) AS total_msgs,
         max(created_at) FILTER (WHERE k = 'c') AS last_client,
         max(created_at) FILTER (WHERE k = 'h') AS last_human
  FROM dm
),
fo AS (
  SELECT (SELECT min(o.created_at) FROM orders o, t
          WHERE o.deleted_at IS NULL AND o.status <> 'cancelled'
            AND analytics_phone_tail(o.customer_phone) = t.tail
            AND o.created_at > f.first_client) AS first_order
  FROM f
),
hmsg AS (
  SELECT dm.created_at,
    coalesce((SELECT array_agg(sm.full_name ORDER BY sm.full_name)
      FROM staff_shifts s JOIN staff_members sm ON sm.id = s.staff_id
      WHERE dm.created_at >= s.started_at AND dm.created_at < coalesce(s.ended_at, now())), '{}') AS names
  FROM dm WHERE dm.k = 'h'
)
SELECT jsonb_build_object(
  'chatIds', coalesce((SELECT jsonb_agg(DISTINCT chat_id) FROM dm), '[]'::jsonb),
  'hasClientMessages', (SELECT first_client IS NOT NULL FROM f),
  'firstClientAt', (SELECT first_client FROM f),
  'firstDialogAt', (SELECT first_dialog FROM f),
  'totalMsgs', (SELECT total_msgs FROM f),
  'firstOrderAt', (SELECT first_order FROM fo),
  'msgsBeforeOrder', (SELECT CASE WHEN fo.first_order IS NULL THEN NULL
                        ELSE (SELECT count(*) FROM dm WHERE dm.created_at < fo.first_order) END FROM fo),
  'humanAfterLastClient', (SELECT f.last_human IS NOT NULL AND f.last_client IS NOT NULL
                             AND f.last_human > f.last_client FROM f),
  'humanMessages', (SELECT count(*) FROM hmsg),
  'served', coalesce((
    SELECT jsonb_agg(jsonb_build_object('names', to_jsonb(g.names), 'messages', g.n,
                                        'firstAt', g.first_at, 'lastAt', g.last_at) ORDER BY g.n DESC)
    FROM (SELECT names, count(*) AS n, min(created_at) AS first_at, max(created_at) AS last_at
          FROM hmsg GROUP BY names) g), '[]'::jsonb)
)
$$;

REVOKE ALL ON FUNCTION public.analytics_chat_names(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_leads(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_purchases(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_staff(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_client_facts(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_msg_kind(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_phone_tail(TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.analytics_chat_names(TEXT[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_leads(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_purchases(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_staff(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_client_facts(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_msg_kind(TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_phone_tail(TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
