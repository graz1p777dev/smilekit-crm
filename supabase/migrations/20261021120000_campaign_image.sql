-- Рассылка с картинкой: ссылка на изображение, текст рассылки уходит подписью.
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS image_url text;
