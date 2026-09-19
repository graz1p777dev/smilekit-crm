// ============================================================
// Core role type — системные роли
// employees.role может содержать также пользовательские роли (string)
// ============================================================
export type UserRole = 'owner' | 'rop' | 'mp' | 'lmai' | 'accountant'

// Уровень доступа роли — используется в RLS и фронтенд-фильтрации
export type UserPermissionLevel = 'owner' | 'department_head' | 'employee' | 'accountant'

export type EmployeeStatus = 'active' | 'vacation' | 'sick' | 'archived'

export type ScheduleType = '5/2' | '2/2' | '1/1' | '3/3' | 'weekends' | 'custom'

// ============================================================
// Consultation statuses (з БД CHECK constraints)
// ============================================================
export type ConsultationStatus =
  | 'Придёт'
  | 'Не придёт'
  | 'Перезапись'
  | 'Отменил'
  | 'Не отвечает'

export type ActualStatus = 'Пришла' | 'Не пришла'

export type StatusAfterFv =
  | 'Купила'
  | 'Не купила'
  | 'Предоплата'
  | 'Дожать'
  | 'Отказ'

export type ConsultationFormat = 'Онлайн' | 'Офлайн'

export type AlbStatus = 'Не записан' | 'Записан' | 'Пришёл' | 'Не пришёл' | 'Купил'

// ============================================================
// Attendance / Schedule
// ============================================================
export type AttendanceStatus =
  | 'present'
  | 'absent'
  | 'sick'
  | 'vacation'
  | 'day_off'
  | 'weekend'
  | 'remote'

// ============================================================
// Finance
// ============================================================
export type TransactionType = 'income' | 'expense'

// ============================================================
// Salary
// ============================================================
export type SalaryStatus = 'draft' | 'approved' | 'paid'

// ============================================================
// KPI
// ============================================================
export type KpiMetricKey =
  | 'fv'
  | 'sales'
  | 'revenue'
  | 'nv'
  | 'appeals'
  | 'leads'
  | 'work_days'

// ============================================================
// Entity interfaces (соответствуют таблицам из 08_Database_Schema.md)
// ============================================================

export interface Employee {
  id: string
  user_id: string | null
  department_id: string | null
  name: string
  phone: string | null
  email: string
  role: string
  avatar_url: string | null
  hire_date: string | null
  birth_date: string | null
  base_salary: number
  kpi_coefficient: number
  schedule_type: ScheduleType
  work_start_time: string
  work_end_time: string
  status: EmployeeStatus
  notes: string | null
  must_change_password: boolean
  /** Раздел «Аналитика» закрыт лично этому сотруднику. */
  analytics_blocked?: boolean
  deleted_at: string | null
  created_at: string
  updated_at: string
  department?: Department
}

export interface Department {
  id: string
  name: string
  manager_id: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
  manager?: Pick<Employee, 'id' | 'name'>
}

export interface Consultation {
  id: string
  date: string
  time: string
  client_name: string
  phone: string | null
  deal_number: string | null
  format: ConsultationFormat | null
  manager_id: string | null
  status: ConsultationStatus | null
  alb_status: AlbStatus | null
  actual_status: ActualStatus | null
  status_after_fv: StatusAfterFv | null
  amount: number
  delivery_cost: number
  is_nv: boolean
  comment: string | null
  consulting_doctor: string | null
  ai_memory: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
  manager?: Pick<Employee, 'id' | 'name'>
}

export interface DailyFact {
  id: string
  employee_id: string
  date: string
  appeals_fact: number | null
  leads_fact: number | null
  fv_fact: number | null
  nv_fact: number | null
  sales_fact: number | null
  revenue_fact: number | null
  work_hours: number | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Decomposition {
  id: string
  employee_id: string
  year: number
  month: number
  plan_fv: number
  plan_sales: number
  plan_revenue: number
  plan_work_days: number
  fact_fv: number
  fact_sales: number
  fact_revenue: number
  fact_work_days: number
  kpi_pct: number
  updated_at: string
}

export interface EmployeeKpi {
  id: string
  employee_id: string
  template_id: string | null
  year: number
  month: number
  plan_fv: number
  plan_sales: number
  plan_revenue: number
  plan_nv: number
  plan_work_days: number
  notes: string | null
  created_at: string
  updated_at: string
}

export interface KpiTemplate {
  id: string
  role: UserRole
  name: string
  metrics: Record<KpiMetricKey, number>
  bonus_threshold: number
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface Salary {
  id: string
  employee_id: string
  year: number
  month: number
  base_amount: number
  kpi_bonus: number
  adjustment: number
  total_amount: number
  status: SalaryStatus
  notes: string | null
  paid_at: string | null
  created_at: string
  updated_at: string
  employee?: Pick<Employee, 'id' | 'name' | 'role'>
}

export interface SalaryCalculation {
  id: string
  salary_id: string
  line_type: string
  description: string
  amount: number
  created_at: string
}

export interface Attendance {
  id: string
  employee_id: string
  schedule_id: string | null
  date: string
  status: AttendanceStatus
  check_in: string | null
  check_out: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Schedule {
  id: string
  employee_id: string
  date: string
  is_work_day: boolean
  planned_start: string | null
  planned_end: string | null
  created_at: string
}

export interface FinanceCategory {
  id: string
  name: string
  type: TransactionType
  is_system: boolean
  color: string | null
  deleted_at: string | null
  created_at: string
}

export interface FinanceTransaction {
  id: string
  category_id: string
  employee_id: string | null
  document_id: string | null
  type: TransactionType
  amount: number
  description: string | null
  transaction_date: string
  deleted_at: string | null
  created_at: string
  updated_at: string
  category?: FinanceCategory
}

export interface Finances {
  id: string
  year: number
  month: number
  income: number
  expense: number
  profit: number
  updated_at: string
}

export interface Investor {
  id: string
  name: string
  share_pct: number
  invested_amount: number
  notes: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export interface InvestorPayout {
  id: string
  investor_id: string
  year: number
  month: number
  amount: number
  transaction_id: string | null
  paid_at: string | null
  created_at: string
  investor?: Pick<Investor, 'id' | 'name'>
}

export interface Notification {
  id: string
  employee_id: string
  type: string
  title: string
  body: string | null
  action_url: string | null
  is_read: boolean
  is_important: boolean
  source_type: string | null
  source_id: string | null
  created_at: string
}

export type DocumentCategory =
  | 'contract' | 'regulation' | 'financial' | 'salary_sheet' | 'template' | 'other'

export interface Document {
  id: string
  name: string
  original_name: string
  category: DocumentCategory
  storage_path: string
  mime_type: string | null
  size_bytes: number | null
  uploaded_by: string | null
  folder_id: string | null
  related_type: string | null
  related_id: string | null
  is_generated: boolean
  deleted_at: string | null
  created_at: string
  updated_at: string
  uploader?: Pick<Employee, 'id' | 'name'>
}

export interface DocumentFolder {
  id: string
  name: string
  parent_id: string | null
  created_by: string | null
  created_at: string
}

export interface Settings {
  id: string
  company_name: string
  logo_url: string | null
  timezone: string
  currency: string
  salary_day: number
  period_close_day: number
  updated_at: string
}

export interface AuditLog {
  id: string
  employee_id: string | null
  action: string
  table_name: string | null
  record_id: string | null
  old_values: Record<string, unknown> | null
  new_values: Record<string, unknown> | null
  ip_address: string | null
  created_at: string
}

// ============================================================
// Лента действий бота (терминал в AI-лаборатории)
// ============================================================

// Соответствует таблице action_logs в базе бота — это не Supabase,
// данные приходят через /api/backend/admin/action-logs.
export interface BotActionLog {
  id: number
  created_at: string | null
  action: string
  status: string
  lead_id: number | null
  amocrm_lead_id: string | null
  client_name: string | null
  error: string | null
  // Выжимка, собранная на стороне бота: набор ключей зависит от action.
  detail: Record<string, unknown>
}

export interface BotActionLogPage {
  items: BotActionLog[]
  last_id: number | null
}

// Тестовый клиент из AI-лаборатории: в базе бота это обычный лид с is_test.
export interface BotTestUser {
  id: number
  amocrm_lead_id: string
  name: string | null
  contact: string | null
  ai_enabled: boolean
  created_at: string | null
  last_message: string | null
  last_message_role: string | null
  pending_approvals: number
}

export interface BotChatMessage {
  id: number
  role: string
  text: string
  status: string
  created_at: string
}

export interface BotActionLogDetail {
  id: number
  created_at: string | null
  action: string
  status: string
  lead_id: number | null
  error: string | null
  request_payload: unknown
  response_payload: unknown
}

// ============================================================
// Dashboard-specific types
// ============================================================

export interface DashboardMonthStats {
  fv: number
  sales: number
  revenue: number
  kpi_pct: number
  plan_fv: number
  plan_sales: number
  plan_revenue: number
}

export interface DashboardTodayStats {
  fv_today: number
  sales_today: number
  revenue_today: number
}

export interface LiveFeedItem {
  id: string
  time: string
  client_name: string
  manager_name: string
  status: ConsultationStatus | ActualStatus | StatusAfterFv | null
  amount: number
  is_nv: boolean
}

export interface TeamMemberStatus {
  id: string
  name: string
  avatar_url: string | null
  role: string
  attendance_status: AttendanceStatus | null
  fv_today: number
  sales_today: number
}

export interface PlanVsFactRow {
  employee_id: string
  employee_name: string
  plan_fv: number
  fact_fv: number
  plan_sales: number
  fact_sales: number
  revenue: number
  kpi_pct: number
}

// ============================================================
// Tasks (канбан-таск-менеджер)
// ============================================================
export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'
export type TaskVisibility = 'all' | 'department' | 'private'

export interface Task {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  visibility: TaskVisibility
  assignee_id: string | null
  created_by: string
  department_id: string | null
  due_date: string | null
  position: number
  created_at: string
  updated_at: string
}

// Задача с развёрнутым списком участников (для приватной видимости).
export interface TaskWithRelations extends Task {
  members: string[] // employee ids
}

// Облегчённая карточка сотрудника — для пикеров исполнителя/участников.
export interface TaskEmployee {
  id: string
  name: string
  role: string
  department_id: string | null
  avatar_url: string | null
}

// Текущий пользователь в контексте задач.
export interface TaskViewer {
  id: string
  role: string
  department_id: string | null
  name: string
}

// ============================================
// СДЕЛКИ (воронка продаж) — supabase/migrations/036_deals.sql
// ============================================

export type DealStageKind = 'normal' | 'won' | 'lost'
export type DealSource = 'telegram' | 'whatsapp' | 'instagram' | 'manual' | 'site' | 'amocrm'
export type DealStatus = 'open' | 'won' | 'lost'
export type DealCurrency = 'KGS' | 'USD' | 'RUB'

export interface DealStage {
  id: string
  name: string
  sort_order: number
  kind: DealStageKind
  color: string
  is_default: boolean
  description: string | null
}

export interface Deal {
  id: string
  title: string
  stage_id: string
  amount: number | null
  currency: DealCurrency
  customer_name: string | null
  customer_phone: string | null
  customer_username: string | null
  city: string | null
  address: string | null
  source: DealSource
  external_key: string | null
  responsible_employee_id: string | null
  note: string | null
  status: DealStatus
  stage_changed_at: string
  created_at: string
  updated_at: string
}

// Переход между этапами — журнал из deal_events.
export interface DealEvent {
  id: string
  deal_id: string
  from_stage_id: string | null
  to_stage_id: string
  employee_id: string | null
  created_at: string
}

// Сообщение переписки, привязанной к сделке (витрина, Wazzup или amoCRM).
export interface DealMessage {
  id: string
  direction: 'in' | 'out'
  text: string
  created_at: string
  /** Автор исходящего для amoCRM-канала: ИИ-бот или живой менеджер. */
  sender?: 'client' | 'bot' | 'operator'
  /** Вложение клиента (чек об оплате, фото) — показываем прямо в переписке. */
  media_url?: string | null
}

// Облегчённая карточка сотрудника — для пикера ответственного и аватара.
export interface DealEmployee {
  id: string
  name: string
  avatar_url: string | null
}

// Текущий пользователь в контексте воронки.
export interface DealViewer {
  id: string
  role: UserRole
  name: string
}

// ============================================
// ЗАКАЗЫ — supabase/migrations/038_orders.sql
// ============================================

export type OrderStatus = 'new' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled'
export type OrderSource = 'telegram_bot' | 'manual'
export type OrderCurrency = 'KGS' | 'USD' | 'RUB'

export interface Order {
  id: string
  customer_name: string | null
  customer_phone: string | null
  customer_username: string | null
  telegram_chat_id: number | null
  /** Количество коробок; null — клиент его не назвал. */
  quantity: number | null
  unit_price: number | null
  total_amount: number | null
  currency: OrderCurrency
  city: string | null
  status: OrderStatus
  source: OrderSource
  /** Текст заказа словами от бота. */
  summary: string | null
  /** Заметка менеджера — бот её не трогает. */
  note: string | null
  external_key: string | null
  deal_id: string | null
  responsible_employee_id: string | null
  created_at: string
  updated_at: string
}

/** Сделка, к которой привязан заказ, — короткой строкой для карточки. */
export interface OrderDealRef {
  id: string
  title: string
  stage_name: string | null
}
