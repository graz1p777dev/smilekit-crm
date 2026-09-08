-- ============================================================
-- Instagram Messaging (официальный Meta API) — только приём/лог входящих
-- сообщений на этом этапе, без автоответа ИИ (см. docs/instagram-meta-setup.md).
-- ============================================================

-- integrations.type ограничен CHECK-констрейнтом из 014_integrations_settings.sql
-- ('crm','telegram','sheets','shop','other') — добавляем 'messaging' и заводим
-- строку для Instagram по тому же паттерну, что amoCRM/Telegram/Google Sheets.
ALTER TABLE public.integrations DROP CONSTRAINT integrations_type_check;
ALTER TABLE public.integrations ADD CONSTRAINT integrations_type_check CHECK (
  type IN ('crm','telegram','sheets','shop','messaging','other')
);

INSERT INTO public.integrations (name, type) VALUES ('Instagram', 'messaging')
ON CONFLICT (name) DO NOTHING;

-- Профиль подключения (зашифрованный токен, id/username аккаунта, срок
-- действия, scopes, статус) хранится в integrations.config JSONB — тот же
-- singleton-паттерн, что settings.extra.smilekit_whatsapp для WhatsApp-бота,
-- см. src/lib/instagram/config.ts.

CREATE TABLE public.instagram_messages (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  mid           TEXT         NOT NULL UNIQUE, -- id сообщения от Meta — дедуп повторных вебхуков
  sender_igsid  TEXT         NOT NULL,        -- Instagram-scoped id клиента
  direction     TEXT         NOT NULL CHECK (direction IN ('in','out')),
  text          TEXT         NOT NULL DEFAULT '',
  raw_payload   JSONB,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_instagram_messages_sender ON public.instagram_messages(sender_igsid);

ALTER TABLE public.instagram_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "instagram_messages_select_owner"
  ON public.instagram_messages FOR SELECT
  TO authenticated
  USING (public.get_my_role() = 'owner');
