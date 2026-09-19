-- ============================================================================
-- 057 · Новые лиды: реклама (кодовое слово) или остальные
--
-- Реклама Click-to-WhatsApp: Meta сама шлёт клиенту автоприветствие
-- «напишите слово "Улыбка"…» (в базу оно не пишется — см.
-- registerOutgoingGreenApiMessage). Признак рекламы — ПЕРВОЕ сообщение
-- клиента начинается со слова «Улыбка» (ulybk… в любом регистре), либо это
-- стандартный текст кнопки Meta «Можно узнать об этом подробнее?».
-- Остальные — органика ИЛИ реклама, где клиент не написал кодовое слово:
-- различить их по базе нельзя.
-- Новый лид — самое первое сообщение клиента в эти дни (как в 048).
-- Купил — заказ (не отменён, не удалён) с номера после первого сообщения.
-- Идемпотентна.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.analytics_ad_source(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH firsts AS (
  SELECT DISTINCT ON (m.chat_id) m.chat_id, m.created_at AS first_client, coalesce(m.text, '') AS text
  FROM chat_messages m
  WHERE m.sender = 'client'
    AND m.chat_id ~ '^[0-9]{9,}$' AND m.chat_id NOT LIKE 'lab%'
    AND m.chat_id IN (SELECT chat_id FROM chat_messages
                      WHERE sender = 'client' AND created_at >= p_from AND created_at < p_to)
    AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE right(s.phone, 9) = right(m.chat_id, 9))
  ORDER BY m.chat_id, m.created_at, m.id
),
cls AS (
  SELECT f.chat_id,
    (f.text ~* '^\s*улыбк' OR f.text ~* 'можно узнать об этом подробнее') AS ad,
    btrim(regexp_replace(lower(left(f.text, 60)), '\s+', ' ', 'g')) AS norm,
    EXISTS (SELECT 1 FROM orders o
            WHERE o.deleted_at IS NULL AND o.status <> 'cancelled'
              AND analytics_phone_tail(o.customer_phone) = right(f.chat_id, 9)
              AND o.created_at > f.first_client) AS bought
  FROM firsts f
  WHERE f.first_client >= p_from AND f.first_client < p_to
)
SELECT jsonb_build_object(
  'ad', jsonb_build_object('clients', (SELECT count(*) FROM cls WHERE ad),
                           'bought', (SELECT count(*) FROM cls WHERE ad AND bought)),
  'other', jsonb_build_object('clients', (SELECT count(*) FROM cls WHERE NOT ad),
                              'bought', (SELECT count(*) FROM cls WHERE NOT ad AND bought)),
  -- Самые частые первые сообщения «остальных» — чтобы было видно, что туда попало.
  'otherTop', coalesce((
    SELECT jsonb_agg(jsonb_build_object('text', norm, 'clients', n) ORDER BY n DESC, norm)
    FROM (SELECT norm, count(*) AS n FROM cls WHERE NOT ad GROUP BY norm ORDER BY 2 DESC, 1 LIMIT 8) t), '[]'::jsonb)
)
$$;

REVOKE ALL ON FUNCTION public.analytics_ad_source(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_ad_source(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
