-- ============================================================================
-- 055 · Нагрузка по часам и дням недели (время Бишкека)
--
-- heat[]  — [день недели 1=пн…7=вс, час 0…23, разных клиентов]: сколько
--           разных лид-чатов прислали хотя бы одно сообщение клиента в этот
--           час этого дня недели (за весь период вместе).
-- hours[] — по часу ПЕРВОГО сообщения клиента в периоде (одна точка на чат,
--           как «Скорость первого ответа» в 049):
--           [час, клиентов, медиана до ответа бота (мин), ответил бот,
--            медиана до ответа человека (мин), ответил человек,
--            ждали дольше 15 мин]
--           «Ждали дольше 15 мин» — первый ответ (бот или человек) пришёл
--           позже 15 минут, или ответа нет, а с сообщения прошло больше 15 мин.
-- Идемпотентна.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.analytics_load(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH cm AS MATERIALIZED (
  SELECT m.chat_id, m.created_at,
         extract(isodow FROM m.created_at AT TIME ZONE 'Asia/Bishkek')::int AS dow,
         extract(hour FROM m.created_at AT TIME ZONE 'Asia/Bishkek')::int AS hr
  FROM chat_messages m
  WHERE m.sender = 'client'
    AND m.created_at >= p_from AND m.created_at < p_to
    AND m.chat_id ~ '^[0-9]{9,}$' AND m.chat_id NOT LIKE 'lab%'
    AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE right(s.phone, 9) = right(m.chat_id, 9))
),
heat AS (
  SELECT dow, hr, count(DISTINCT chat_id) AS n FROM cm GROUP BY dow, hr
),
firsts AS (
  SELECT DISTINCT ON (chat_id) chat_id, created_at AS first_at, hr
  FROM cm ORDER BY chat_id, created_at
),
fr AS (
  SELECT f.hr, f.first_at, r.bot_at, r.human_at
  FROM firsts f
  LEFT JOIN LATERAL (
    SELECT
      min(m.created_at) FILTER (WHERE analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) = 'b') AS bot_at,
      min(m.created_at) FILTER (WHERE analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) = 'h') AS human_at
    FROM chat_messages m
    WHERE m.chat_id = f.chat_id AND m.created_at > f.first_at
  ) r ON true
),
mins AS (
  SELECT hr,
    extract(epoch FROM (bot_at - first_at)) / 60 AS bot_min,
    extract(epoch FROM (human_at - first_at)) / 60 AS human_min,
    coalesce(least(bot_at, human_at), greatest(now(), first_at)) - first_at > interval '15 minutes' AS over15
  FROM fr
)
SELECT jsonb_build_object(
  'heat', coalesce((SELECT jsonb_agg(jsonb_build_array(dow, hr, n) ORDER BY dow, hr) FROM heat), '[]'::jsonb),
  'hours', coalesce((
    SELECT jsonb_agg(h.row ORDER BY h.hr)
    FROM (
      SELECT hr, jsonb_build_array(
        hr, count(*),
        percentile_cont(0.5) WITHIN GROUP (ORDER BY bot_min),
        count(bot_min),
        percentile_cont(0.5) WITHIN GROUP (ORDER BY human_min),
        count(human_min),
        count(*) FILTER (WHERE over15)
      ) AS row
      FROM mins GROUP BY hr
    ) h), '[]'::jsonb)
)
$$;

REVOKE ALL ON FUNCTION public.analytics_load(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_load(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
