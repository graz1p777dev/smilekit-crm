-- ============================================================================
-- 059 · Вернувшиеся клиенты
--
-- Возвращение — сообщение клиента в периоде, перед которым клиент молчал
-- не меньше 3 суток (предыдущее сообщение КЛИЕНТА в этом чате — раньше чем
-- за 72 часа; наши сообщения молчание не прерывают). Клиент считается один
-- раз — по первому возвращению в периоде.
--   afterCampaign — за 24 часа до возвращения этому чату ушла рассылка
--                   (campaign_recipients: status 'sent', sent_at);
--   self          — остальные;
--   bought        — заказ (не отменён, не удалён) с номера после возвращения.
-- Лид — chat_id из цифр, не lab, не телефон сотрудника.
-- Идемпотентна.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.analytics_returning(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH cm AS (
  SELECT m.chat_id, m.created_at,
         lag(m.created_at) OVER (PARTITION BY m.chat_id ORDER BY m.created_at, m.id) AS prev_at
  FROM chat_messages m
  WHERE m.sender = 'client'
    AND m.created_at < p_to
    AND m.chat_id ~ '^[0-9]{9,}$' AND m.chat_id NOT LIKE 'lab%'
    AND m.chat_id IN (SELECT chat_id FROM chat_messages
                      WHERE sender = 'client' AND created_at >= p_from AND created_at < p_to)
    AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE right(s.phone, 9) = right(m.chat_id, 9))
),
ret AS (
  SELECT chat_id, min(created_at) AS at
  FROM cm
  WHERE created_at >= p_from AND prev_at IS NOT NULL AND created_at - prev_at >= interval '72 hours'
  GROUP BY chat_id
),
cls AS (
  SELECT r.chat_id,
    EXISTS (SELECT 1 FROM campaign_recipients cr
            WHERE cr.chat_id = r.chat_id AND cr.status = 'sent'
              AND cr.sent_at <= r.at AND cr.sent_at > r.at - interval '24 hours') AS after_campaign,
    EXISTS (SELECT 1 FROM orders o
            WHERE o.deleted_at IS NULL AND o.status <> 'cancelled'
              AND analytics_phone_tail(o.customer_phone) = right(r.chat_id, 9)
              AND o.created_at > r.at) AS bought
  FROM ret r
)
SELECT jsonb_build_object(
  'wrote', (SELECT count(DISTINCT chat_id) FROM cm WHERE created_at >= p_from),
  'returned', (SELECT count(*) FROM cls),
  'afterCampaign', jsonb_build_object('clients', (SELECT count(*) FROM cls WHERE after_campaign),
                                      'bought', (SELECT count(*) FROM cls WHERE after_campaign AND bought)),
  'self', jsonb_build_object('clients', (SELECT count(*) FROM cls WHERE NOT after_campaign),
                             'bought', (SELECT count(*) FROM cls WHERE NOT after_campaign AND bought))
)
$$;

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_chat_sent
  ON public.campaign_recipients (chat_id, sent_at) WHERE status = 'sent';

REVOKE ALL ON FUNCTION public.analytics_returning(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_returning(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
