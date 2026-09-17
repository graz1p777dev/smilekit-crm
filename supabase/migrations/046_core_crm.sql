-- ============================================================================
-- Ядро CRM: клиенты, платежи, смены, проекты и воронки.
--
-- Задача — закрыть пробелы, из-за которых сейчас нельзя вести учёт:
--   * клиент не существует как сущность (дублируется в deals и orders);
--   * оплата хранится одним числом, истории платежей нет;
--   * смены менеджеров не фиксируются (attendance — статус на день, не смена);
--   * воронка одна и жёстко общая, проекта/арендатора нет вовсе.
--
-- Всё идемпотентно: можно запускать повторно.
--
-- ВАЖНО про совместимость: новые колонки добавляются как NULLABLE, старый код
-- продолжает работать без них. Ни одна существующая колонка не удаляется и не
-- переименовывается.
-- ============================================================================

-- ─── Проект (арендатор) ─────────────────────────────────────────────────────
-- Пока проект один, но всё новое сразу знает про него: добавить второй бизнес
-- позже будет вопросом данных, а не переписывания схемы.
CREATE TABLE IF NOT EXISTS public.projects (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT         NOT NULL UNIQUE,
  name       TEXT         NOT NULL,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

INSERT INTO public.projects (code, name)
VALUES ('smilekit', 'SmileKit')
ON CONFLICT (code) DO NOTHING;

-- ─── Воронки ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pipelines (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID         NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  code       TEXT         NOT NULL,
  name       TEXT         NOT NULL,
  sort_order INTEGER      NOT NULL DEFAULT 0,
  is_default BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (project_id, code)
);

INSERT INTO public.pipelines (project_id, code, name, is_default)
SELECT id, 'sales', 'Продажи', TRUE FROM public.projects WHERE code = 'smilekit'
ON CONFLICT (project_id, code) DO NOTHING;

-- Существующие этапы привязываем к воронке продаж.
ALTER TABLE public.deal_stages ADD COLUMN IF NOT EXISTS pipeline_id UUID
  REFERENCES public.pipelines(id) ON DELETE CASCADE;
UPDATE public.deal_stages SET pipeline_id = (
  SELECT id FROM public.pipelines WHERE code = 'sales' LIMIT 1
) WHERE pipeline_id IS NULL;

-- ─── Клиент ─────────────────────────────────────────────────────────────────
-- Центральная сущность, которой не хватало: один человек — одна строка,
-- независимо от того, из какого канала пришёл и сколько раз покупал.
--
-- phone_key — последние 9 цифр номера. Именно по ним код и так везде склеивает
-- клиентов (формат номера в базе разный: 996…, 0…, +996…). Уникальность
-- в рамках проекта не даёт развести дубли одного человека.
CREATE TABLE IF NOT EXISTS public.clients (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID         NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name              VARCHAR(200),
  phone             VARCHAR(32),
  phone_key         VARCHAR(9),
  username          VARCHAR(120),
  telegram_chat_id  BIGINT,
  instagram_igsid   TEXT,
  city              VARCHAR(120),
  note              TEXT,
  -- Пользовательские поля без EAV: свои поля под другой бизнес добавляются
  -- сюда, не трогая схему.
  custom            JSONB        NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_phone_key
  ON public.clients(project_id, phone_key) WHERE phone_key IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_telegram
  ON public.clients(project_id, telegram_chat_id) WHERE telegram_chat_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_instagram
  ON public.clients(project_id, instagram_igsid) WHERE instagram_igsid IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS set_clients_updated_at ON public.clients;
CREATE TRIGGER set_clients_updated_at
  BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Связи. NULLABLE: старый код, который их не знает, продолжает работать.
ALTER TABLE public.deals  ADD COLUMN IF NOT EXISTS client_id  UUID REFERENCES public.clients(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS client_id  UUID REFERENCES public.clients(id) ON DELETE SET NULL;
ALTER TABLE public.deals  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL;
ALTER TABLE public.deals  ADD COLUMN IF NOT EXISTS pipeline_id UUID REFERENCES public.pipelines(id) ON DELETE SET NULL;
ALTER TABLE public.deals  ADD COLUMN IF NOT EXISTS custom JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_deals_client  ON public.deals(client_id);
CREATE INDEX IF NOT EXISTS idx_orders_client ON public.orders(client_id);

-- ─── Платежи ────────────────────────────────────────────────────────────────
-- Каждый платёж — отдельная строка. Оплачено = сумма строк, остаток и статус
-- считаются, а не хранятся: иначе история теряется, а число рано или поздно
-- разъезжается с реальностью.
CREATE TABLE IF NOT EXISTS public.payments (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID         REFERENCES public.projects(id) ON DELETE SET NULL,
  deal_id    UUID         REFERENCES public.deals(id)  ON DELETE CASCADE,
  order_id   UUID         REFERENCES public.orders(id) ON DELETE SET NULL,
  client_id  UUID         REFERENCES public.clients(id) ON DELETE SET NULL,

  amount     NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency   TEXT          NOT NULL DEFAULT 'KGS',
  -- prepayment — предоплата, payment — оплата/доплата, refund — возврат.
  -- ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ЗАКАЗЧИКА: правила возвратов не определены, поэтому
  -- refund пока просто уменьшает оплаченное и ничего больше не делает.
  kind       TEXT          NOT NULL DEFAULT 'payment'
             CHECK (kind IN ('prepayment', 'payment', 'refund')),
  -- ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ: перечень способов оплаты не согласован, поэтому
  -- свободный текст, а не CHECK — чтобы не пришлось менять схему.
  method     TEXT,
  paid_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  note       TEXT,
  created_by UUID          REFERENCES public.employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT payments_currency_check CHECK (currency IN ('KGS','USD','RUB')),
  CONSTRAINT payments_target_check   CHECK (deal_id IS NOT NULL OR order_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_payments_deal   ON public.payments(deal_id)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payments_client ON public.payments(client_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payments_paid   ON public.payments(paid_at)   WHERE deleted_at IS NULL;

-- ─── Смены менеджеров ───────────────────────────────────────────────────────
-- attendance (005) — это статус на день («работал/болел»), сменой он быть не
-- может: нет ни времени начала, ни окончания. Заводим отдельную сущность.
--
-- Статистику смены НЕ храним снимком: она считается запросом по времени
-- смены. Так её можно пересчитать задним числом, когда бизнес-правила
-- уточнятся, а не переписывать сохранённые числа.
CREATE TABLE IF NOT EXISTS public.shifts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID        REFERENCES public.projects(id) ON DELETE SET NULL,
  employee_id UUID        NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ,
  open_note   TEXT,
  close_note  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT shifts_period_check CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- Одна открытая смена на сотрудника: вторую «Начать смену» база не пропустит.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_open
  ON public.shifts(employee_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shifts_started ON public.shifts(started_at);

-- ─── Расходы ────────────────────────────────────────────────────────────────
-- Отдельную таблицу НЕ заводим: finance_transactions (010) уже содержит сумму,
-- категорию, дату, описание и автора, а source_type='manual' предусмотрен для
-- ручных проводок. Добавляем только недостающую привязку к проекту.
ALTER TABLE public.finance_transactions
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL;

-- ─── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.projects  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shifts    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "projects_select"  ON public.projects;
CREATE POLICY "projects_select"  ON public.projects  FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS "pipelines_select" ON public.pipelines;
CREATE POLICY "pipelines_select" ON public.pipelines FOR SELECT TO authenticated USING (TRUE);

-- Клиентов и платежи видят те же роли, что и сделки.
DROP POLICY IF EXISTS "clients_select" ON public.clients;
CREATE POLICY "clients_select" ON public.clients FOR SELECT TO authenticated
  USING (public.get_my_role() IN ('owner','rop','mp','lmai'));
DROP POLICY IF EXISTS "payments_select" ON public.payments;
CREATE POLICY "payments_select" ON public.payments FOR SELECT TO authenticated
  USING (public.get_my_role() IN ('owner','rop','mp','lmai','accountant'));

-- Свою смену видит каждый, чужие — руководители.
DROP POLICY IF EXISTS "shifts_select" ON public.shifts;
CREATE POLICY "shifts_select" ON public.shifts FOR SELECT TO authenticated
  USING (public.get_my_role() IN ('owner','rop') OR employee_id = public.get_my_employee_id());

GRANT SELECT ON public.projects, public.pipelines, public.clients, public.payments, public.shifts TO authenticated;
GRANT ALL    ON public.projects, public.pipelines, public.clients, public.payments, public.shifts TO service_role;

NOTIFY pgrst, 'reload schema';
