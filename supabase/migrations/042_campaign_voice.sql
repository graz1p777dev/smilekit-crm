-- Голосовые рассылки.
--
-- Рассылка теперь может быть голосовой: файл лежит в public/voice/ репозитория
-- CRM и раздаётся её же доменом, а Green API отправляет голосовое по ссылке.
-- В базе храним только идентификатор из src/config/voice-messages.ts —
-- ни файла, ни URL: домен может смениться, id нет.
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS voice_id TEXT;

-- У голосовой рассылки текста может не быть вовсе, поэтому прежнее
-- «сообщение от 1 до 4000 символов» больше не годится: снимаем NOT NULL и
-- переписываем CHECK так, чтобы пустой текст допускался только вместе с
-- голосовым — рассылка без того и другого по-прежнему бессмысленна.
ALTER TABLE public.campaigns
  ALTER COLUMN message DROP NOT NULL;

ALTER TABLE public.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_message_check;

ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_message_check CHECK (
    (message IS NOT NULL AND char_length(btrim(message)) BETWEEN 1 AND 4000)
    OR (voice_id IS NOT NULL AND btrim(coalesce(voice_id, '')) <> '')
  );
