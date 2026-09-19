-- ============================================================================
-- 062 · Рассылки: доставлено и прочитано
--
-- Та же analytics_campaigns, что в 049 (все прежние поля и их смысл — без
-- изменений), плюс по каждой рассылке:
--   tracked   — отправленных, у которых сохранён id сообщения Green API
--               (provider_message_id, колонка из 052): по ним приходит статус;
--   delivered — отправленных, у которых есть delivered_at или read_at
--               (прочитанное считается и доставленным);
--   read      — отправленных с read_at.
-- tracked = 0 — рассылка ушла до начала учёта статусов: данных нет.
-- Идемпотентна.
-- ============================================================================

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
    r.provider_message_id, r.delivered_at, r.read_at,
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
  'bought', (SELECT count(*) FROM r WHERE r.campaign_id = c.id AND r.bought),
  'tracked', (SELECT count(*) FROM r WHERE r.campaign_id = c.id AND r.status = 'sent'
                AND r.provider_message_id IS NOT NULL),
  'delivered', (SELECT count(*) FROM r WHERE r.campaign_id = c.id AND r.status = 'sent'
                  AND (r.delivered_at IS NOT NULL OR r.read_at IS NOT NULL)),
  'read', (SELECT count(*) FROM r WHERE r.campaign_id = c.id AND r.status = 'sent' AND r.read_at IS NOT NULL)
) ORDER BY c.at DESC), '[]'::jsonb)
FROM c
$$;

REVOKE ALL ON FUNCTION public.analytics_campaigns(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analytics_campaigns(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

NOTIFY pgrst, 'reload schema';
