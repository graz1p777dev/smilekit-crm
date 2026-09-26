-- ============================================================
-- Instagram: автоответ бота в директе и в комментариях.
--
-- До этой миграции instagram_messages только логировала входящие. Теперь в
-- той же таблице живут и исходящие бота/менеджера — по ним же считается,
-- «ведёт ли чат менеджер» (тот же принцип, что chat_messages.sender для
-- WhatsApp) и открыто ли 24-часовое окно Meta для свободного текста.
-- ============================================================

-- Кто написал: клиент, бот или живой менеджер из CRM. Для уже накопленных
-- строк значение по умолчанию верное — до этой миграции сохранялись только
-- входящие от клиента.
ALTER TABLE public.instagram_messages
  ADD COLUMN IF NOT EXISTS sender TEXT NOT NULL DEFAULT 'client'
    CHECK (sender IN ('client','bot','operator'));

-- Имя/ник автора из Graph API — чтобы в CRM было видно человека, а не igsid.
ALTER TABLE public.instagram_messages
  ADD COLUMN IF NOT EXISTS author_name TEXT;

-- Что стало с исходящим: 'sent' — ушло, 'window_closed' — не отправляли,
-- потому что прошло больше 24 часов с последнего сообщения клиента (Meta
-- запрещает свободный текст вне этого окна), 'failed' — Graph API отказал.
ALTER TABLE public.instagram_messages
  ADD COLUMN IF NOT EXISTS status TEXT;

-- История диалога читается «последние N по одному igsid» — без этого индекса
-- это seq scan по всей таблице на каждое входящее сообщение.
CREATE INDEX IF NOT EXISTS idx_instagram_messages_sender_created
  ON public.instagram_messages(sender_igsid, created_at DESC);

-- ============================================================
-- Комментарии под постами: лог входящего комментария, публичного ответа бота
-- и приватного ответа в директ (Meta разрешает его один раз на комментарий).
-- UNIQUE(comment_id) — дедуп повторной доставки вебхука, тем же приёмом, что
-- instagram_messages.mid.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.instagram_comments (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id         TEXT        NOT NULL UNIQUE,
  media_id           TEXT,
  parent_comment_id  TEXT,
  author_igsid       TEXT,
  author_username    TEXT,
  text               TEXT        NOT NULL DEFAULT '',
  commented_at       TIMESTAMPTZ,
  reply_text         TEXT,
  private_reply_sent BOOLEAN     NOT NULL DEFAULT false,
  -- 'received' — только сохранили (бот выключен/это наш собственный
  -- комментарий), 'replied' — публичный ответ ушёл, 'failed' — Graph API отказал.
  status             TEXT        NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','replied','failed')),
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_instagram_comments_created
  ON public.instagram_comments(created_at DESC);

ALTER TABLE public.instagram_comments ENABLE ROW LEVEL SECURITY;

-- Те же права, что у instagram_messages: читает только владелец, пишет
-- service_role (вебхук идёт вне сессии пользователя).
CREATE POLICY "instagram_comments_select_owner"
  ON public.instagram_comments FOR SELECT
  TO authenticated
  USING (public.get_my_role() = 'owner');

GRANT SELECT ON public.instagram_comments TO authenticated;
GRANT ALL ON public.instagram_comments TO service_role;

-- ============================================================
-- Стоп-список Instagram — аналог campaign_opt_outs.block_bot_replies для
-- WhatsApp. Отдельной таблицей, а не строкой в campaign_opt_outs: там ключ —
-- телефон (CHECK '^[0-9]{5,20}$'), а у клиента из Instagram телефона нет,
-- есть только igsid. Бот такому клиенту не пишет вообще, но история и сделка
-- продолжают вестись.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.instagram_opt_outs (
  igsid      TEXT        PRIMARY KEY,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.instagram_opt_outs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "instagram_opt_outs_select_owner"
  ON public.instagram_opt_outs FOR SELECT
  TO authenticated
  USING (public.get_my_role() = 'owner');

GRANT SELECT ON public.instagram_opt_outs TO authenticated;
GRANT ALL ON public.instagram_opt_outs TO service_role;
