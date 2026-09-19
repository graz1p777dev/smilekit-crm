-- ============================================================================
-- 064 · Подбор аудитории рассылки одним запросом
--
-- Раньше selectRecipients() (src/actions/campaigns.ts) вычитывал в Node все
-- сделки (12+ тыс., постранично по 1000), весь chat_control, все сообщения
-- клиентов за период и campaign_recipients — на КАЖДОЕ изменение фильтра в
-- предпросмотре. Здесь те же правила, но в базе:
--   * сделка не удалена; для audience <> 'all' — status <> 'won';
--   * external_key не пуст; 'not_purchased' — нет живого заказа
--     (orders: status <> 'cancelled', не удалён), 'purchased' — есть;
--   * номер (из greenapi:<номер> или customer_phone, только цифры) не в
--     campaign_opt_outs;
--   * Telegram (source = 'telegram', ключ telegram:<id>) — только без фильтра
--     по дате, id — целое число;
--   * остальное — WhatsApp: только если Green API настроен, в номере >= 9
--     цифр; при фильтре по дате — последнее (по id) сообщение клиента с этого
--     номера начиная с p_from лежит в [p_from, p_to] (с точностью до мс, как
--     в JS);
--   * «уже получили» (campaign_recipients.status = 'sent', sent_at >=
--     p_skip_reached_since) — исключаем и считаем;
--   * «менеджер в переписке» — список чатов считает Node тем же правилом
--     isManagerActiveInChat (src/lib/campaigns/manager-activity.ts) и передаёт
--     сюда: считаем, исключаем, если p_include_manager_chats = false.
-- Порядок получателей — по deal id, как было.
-- p_with_list = false — только числа (предпросмотр), без списка.
-- Идемпотентна.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.campaign_audience(
  p_audience TEXT,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_skip_reached_since TIMESTAMPTZ,
  p_manager_chat_ids TEXT[],
  p_include_manager_chats BOOLEAN,
  p_whatsapp_ready BOOLEAN,
  p_with_list BOOLEAN
)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
WITH purchased AS (
  SELECT DISTINCT deal_id FROM orders
  WHERE status <> 'cancelled' AND deleted_at IS NULL AND deal_id IS NOT NULL
),
base AS (
  SELECT d.id, coalesce(d.source, '') AS source, coalesce(d.external_key, '') AS key,
    regexp_replace(
      CASE WHEN coalesce(d.external_key, '') LIKE 'greenapi:%'
        THEN substr(d.external_key, 10) ELSE coalesce(d.customer_phone, '') END,
      '[^0-9]', '', 'g'
    ) AS phone,
    EXISTS (SELECT 1 FROM purchased p WHERE p.deal_id = d.id) AS bought
  FROM deals d
  WHERE d.deleted_at IS NULL AND (p_audience = 'all' OR d.status <> 'won')
),
cand AS (
  SELECT b.* FROM base b
  WHERE b.key <> ''
    AND (p_audience <> 'not_purchased' OR NOT b.bought)
    AND (p_audience <> 'purchased' OR b.bought)
    AND NOT EXISTS (SELECT 1 FROM campaign_opt_outs o WHERE o.phone = b.phone)
),
tg AS (
  SELECT c.id, 'telegram'::text AS channel, c.key, substr(c.key, 10) AS chat_id, NULL::text AS lead_id
  FROM cand c
  WHERE c.source = 'telegram' AND c.key LIKE 'telegram:%'
    AND p_from IS NULL AND p_to IS NULL
    AND substr(c.key, 10) ~ '^-?[0-9]+$'
),
-- Последнее по id сообщение клиента на номер, начиная с p_from.
last_client AS (
  SELECT DISTINCT ON (m.phone) m.phone, m.created_at
  FROM (
    SELECT regexp_replace(coalesce(chat_id, ''), '[^0-9]', '', 'g') AS phone, created_at, id
    FROM chat_messages
    WHERE sender = 'client'
      AND (p_from IS NOT NULL OR p_to IS NOT NULL)
      -- coalesce, а не «p_from IS NULL OR …»: так граница идёт в индекс
      -- idx_chat_messages_client_created, а не фильтром по всем строкам.
      AND created_at >= coalesce(p_from, '-infinity'::timestamptz)
  ) m
  WHERE m.phone <> ''
  ORDER BY m.phone, m.id DESC
),
reached AS (
  SELECT DISTINCT regexp_replace(coalesce(chat_id, ''), '[^0-9]', '', 'g') AS phone
  FROM campaign_recipients
  WHERE p_skip_reached_since IS NOT NULL AND status = 'sent' AND sent_at >= p_skip_reached_since
),
wa AS (
  SELECT c.id, c.key, c.phone,
    EXISTS (SELECT 1 FROM reached r WHERE r.phone = c.phone) AS was_reached,
    c.phone = ANY (coalesce(p_manager_chat_ids, '{}')) AS in_manager
  FROM cand c
  WHERE NOT (c.source = 'telegram' AND c.key LIKE 'telegram:%')
    AND p_whatsapp_ready
    AND length(c.phone) >= 9
    AND (
      (p_from IS NULL AND p_to IS NULL)
      OR EXISTS (
        SELECT 1 FROM last_client lc
        WHERE lc.phone = c.phone
          -- JS сравнивал миллисекунды (Date.getTime), микросекунды отбрасывал.
          AND (p_from IS NULL OR date_trunc('milliseconds', lc.created_at) >= p_from)
          AND (p_to IS NULL OR date_trunc('milliseconds', lc.created_at) <= p_to)
      )
    )
),
final AS (
  SELECT id, channel, key, chat_id, lead_id FROM tg
  UNION ALL
  SELECT id, 'whatsapp', key, phone,
    CASE WHEN key LIKE 'amocrm:%' THEN substr(key, 8) END
  FROM wa
  WHERE NOT was_reached AND (NOT in_manager OR p_include_manager_chats)
)
SELECT jsonb_build_object(
  'count', (SELECT count(*) FROM final),
  'already_reached', (SELECT count(*) FROM wa WHERE was_reached),
  'manager_chats', (SELECT count(*) FROM wa WHERE NOT was_reached AND in_manager),
  'recipients', CASE WHEN p_with_list THEN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'deal_id', id, 'channel', channel, 'external_key', key, 'chat_id', chat_id,
      'lead_id', lead_id, 'contact_id', NULL
    ) ORDER BY id), '[]'::jsonb) FROM final
  ) END
)
$$;

REVOKE ALL ON FUNCTION public.campaign_audience(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT[], BOOLEAN, BOOLEAN, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
