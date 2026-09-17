-- ============================================================================
-- 047 · Смены сотрудников
--
-- Сотрудники смен — НЕ пользователи CRM. У них только имя, телефон и простой
-- пароль, который заводит владелец. По смене считается, кто в какое время
-- обслуживал клиентов: все ответы с телефона WhatsApp подписаны одним
-- «Smilekit», и без смен отличить людей невозможно.
--
-- Все таблицы пишет только сервер CRM (service_role). Браузеру и роли
-- authenticated доступа нет — страница /smena работает без входа в CRM.
-- Идемпотентна.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.staff_members (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     TEXT        NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 80),
  -- Только цифры, как chat_id в chat_messages: 996700123456.
  phone         TEXT        NOT NULL CHECK (phone ~ '^[0-9]{9,15}$'),
  -- HMAC-SHA256(пароль) с секретом сервера. Детерминированный — вход идёт по
  -- одному паролю без имени, поэтому пароль обязан быть уникальным.
  password_hash TEXT        NOT NULL UNIQUE,
  telegram_id   BIGINT      UNIQUE,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.staff_shifts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     UUID        NOT NULL REFERENCES public.staff_members(id) ON DELETE CASCADE,
  -- solo — «Моя смена», joint — «Работа вместе».
  mode         TEXT        NOT NULL CHECK (mode IN ('solo', 'joint')),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,
  -- closed — сам закрыл, replaced — смену забрали, owner — закрыл владелец.
  ended_reason TEXT        CHECK (ended_reason IN ('closed', 'replaced', 'owner')),
  request_id   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staff_shifts_period_check CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- Одна открытая смена на человека.
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_shifts_one_open
  ON public.staff_shifts(staff_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_staff_shifts_period ON public.staff_shifts(started_at, ended_at);

-- Запрос «Моя смена» / «Работа вместе», пока его не подтвердил тот, кто
-- сейчас на смене (или владелец).
CREATE TABLE IF NOT EXISTS public.staff_shift_requests (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id  UUID        NOT NULL REFERENCES public.staff_members(id) ON DELETE CASCADE,
  kind          TEXT        NOT NULL CHECK (kind IN ('take', 'join')),
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  -- Секрет ссылки подтверждения из WhatsApp.
  token         TEXT        NOT NULL UNIQUE,
  -- Кто был на смене в момент запроса — им и уходит подтверждение.
  on_shift_ids  UUID[]      NOT NULL DEFAULT '{}',
  decided_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ
);

-- Один ожидающий запрос на человека.
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_requests_one_pending
  ON public.staff_shift_requests(requester_id) WHERE status = 'pending';

-- 5 неверных паролей — блок на 5 минут. Ключ: ip:<адрес> или tg:<id>.
CREATE TABLE IF NOT EXISTS public.staff_login_guard (
  key           TEXT        PRIMARY KEY,
  failures      INT         NOT NULL DEFAULT 0,
  blocked_until TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Напоминание «клиент ждёт 15 минут» уходит один раз на сообщение клиента.
CREATE TABLE IF NOT EXISTS public.staff_reply_reminders (
  message_id  BIGINT      NOT NULL,
  staff_id    UUID        NOT NULL REFERENCES public.staff_members(id) ON DELETE CASCADE,
  chat_id     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, staff_id)
);

-- Аналитика и напоминания выбирают переписку по времени — без индекса это
-- полный проход по всей таблице сообщений.
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON public.chat_messages(created_at);

ALTER TABLE public.staff_members         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_shifts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_shift_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_login_guard     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_reply_reminders ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.staff_members, public.staff_shifts, public.staff_shift_requests,
  public.staff_login_guard, public.staff_reply_reminders TO service_role;

NOTIFY pgrst, 'reload schema';
