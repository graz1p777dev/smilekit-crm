-- ============================================================================
-- 061 · Сотрудники: скорость ответа и ожидание в их смены
--
-- Обращение — первое сообщение клиента после ответа человека или после
-- метки «передано менеджеру» (её время — последней карточки, см. 049);
-- сообщения бота между ними не учитываются. Диалоги, которые целиком ведёт
-- бот (человек не писал, передачи не было), ответа человека не ждут и сюда
-- не попадают.
-- Обращение засчитывается сотруднику, если пришло во время его смены
-- (смена обрезана периодом; «вместе» — обоим). Ответ — следующее сообщение
-- человека в этом чате (с телефона или из CRM, не рассылка), когда угодно.
--   medianMin — медиана минут от обращения до ответа (по отвеченным);
--   waits     — обращений в его смены; answered — из них с ответом;
--   over15    — разных клиентов, у которых хотя бы одно обращение в его
--               смену ждало ответа человека дольше 15 минут (или ответа нет,
--               а прошло больше 15 минут).
-- «Клиентов в час смены» считает TypeScript: лиды смены (analytics_staff)
-- на часы смены.
--
-- analytics_staff_speed_core принимает смены параметром — так логику можно
-- проверить на временных сменах без записи в базу; analytics_staff_speed
-- подставляет настоящие staff_shifts.
-- Идемпотентна.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.analytics_staff_speed_core(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ, p_shifts JSONB)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH sh AS (
  SELECT (s->>'staffId')::uuid AS staff_id,
         greatest((s->>'from')::timestamptz, p_from) AS cs,
         least(coalesce((s->>'to')::timestamptz, now()), p_to) AS ce
  FROM jsonb_array_elements(coalesce(p_shifts, '[]'::jsonb)) s
),
span AS (SELECT min(cs) AS a, max(ce) AS b FROM sh),
chats AS (
  SELECT DISTINCT m.chat_id
  FROM chat_messages m, span
  WHERE m.sender = 'client'
    AND m.created_at >= span.a AND m.created_at < span.b
    AND m.chat_id ~ '^[0-9]{9,}$' AND m.chat_id NOT LIKE 'lab%'
    AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE right(s.phone, 9) = right(m.chat_id, 9))
),
ch AS (
  -- Клиент 'c', человек 'h' и метка передачи 'x'. Бот серию ожидания
  -- человека не прерывает.
  SELECT m.chat_id, m.id, m.created_at, kk.k,
         lag(kk.k) OVER w AS prev_k,
         min(CASE WHEN kk.k = 'h' THEN m.created_at END)
           OVER (w ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) AS next_h
  FROM chats c
  JOIN chat_messages m ON m.chat_id = c.chat_id
  CROSS JOIN LATERAL (SELECT CASE
    WHEN m.amo_message_id LIKE 'ga:claim:handed-off:%' THEN 'x'
    ELSE analytics_msg_kind(m.sender, m.author_name, m.amo_message_id) END AS k) kk
  WHERE kk.k IN ('c', 'h', 'x')
  WINDOW w AS (PARTITION BY m.chat_id ORDER BY m.created_at, m.id)
),
starts AS (
  -- Первое сообщение клиента после ответа человека или после передачи.
  SELECT s.chat_id, s.created_at AS at, s.next_h AS answer_at
  FROM ch s, span
  WHERE s.k = 'c' AND s.prev_k IN ('h', 'x')
    AND s.created_at >= span.a AND s.created_at < span.b
),
per AS (
  SELECT DISTINCT sh.staff_id, st.chat_id, st.at, st.answer_at
  FROM starts st JOIN sh ON st.at >= sh.cs AND st.at < sh.ce
)
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'staffId', staff_id,
  'medianMin', median_min,
  'waits', waits,
  'answered', answered,
  'over15', over15
)), '[]'::jsonb)
FROM (
  SELECT staff_id,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (answer_at - at)) / 60)
      FILTER (WHERE answer_at IS NOT NULL) AS median_min,
    count(*) AS waits,
    count(answer_at) AS answered,
    count(DISTINCT chat_id) FILTER (
      WHERE coalesce(answer_at, greatest(now(), at)) - at > interval '15 minutes') AS over15
  FROM per GROUP BY staff_id
) x
$$;

CREATE OR REPLACE FUNCTION public.analytics_staff_speed(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
SELECT analytics_staff_speed_core(p_from, p_to, (
  SELECT jsonb_agg(jsonb_build_object('staffId', s.staff_id, 'from', s.started_at, 'to', s.ended_at))
  FROM staff_shifts s
  WHERE s.started_at < p_to AND coalesce(s.ended_at, now()) > p_from
))
$$;

REVOKE ALL ON FUNCTION public.analytics_staff_speed_core(TIMESTAMPTZ, TIMESTAMPTZ, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analytics_staff_speed(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_staff_speed_core(TIMESTAMPTZ, TIMESTAMPTZ, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.analytics_staff_speed(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
