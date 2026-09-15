'use server'

// Зарплата = проценты, которые владелец задаёт сам.
//
// Правила лежат в settings.extra.salaryCommission — колонка JSONB, которая в
// схеме уже есть (014_integrations_settings.sql), поэтому отдельная миграция
// не нужна и расчёт работает сразу.
//
// «Свой клиент» — тот, кому сотрудник ответил ПОСЛЕДНИМ. Так клиент
// закрепляется ровно за одним человеком: если считать по «хоть раз ответил»,
// одна и та же выручка попала бы в процент сразу нескольким и фонд оплаты
// вырос бы на пустом месте.

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  calculateSalaries,
  type SalaryCalculation,
  type SalaryRule,
} from '@/lib/salary/commission'

async function viewer(): Promise<{ id: string; role: string } | null> {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  const { data } = await supabase
    .from('employees')
    .select('id, role')
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .maybeSingle()
  return (data as { id: string; role: string } | null) ?? null
}

/** Телефон сводим к последним 9 цифрам: формат номера в базе разный. */
const phoneKey = (value: string | null | undefined) => {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits ? digits.slice(-9) : ''
}

// ─── Правила ─────────────────────────────────────────────────────────────────

async function readSettings(): Promise<{ id: string; extra: Record<string, unknown> } | null> {
  const admin = createAdminClient()
  const { data } = await admin.from('settings').select('id, extra').limit(1).maybeSingle()
  return (data as { id: string; extra: Record<string, unknown> } | null) ?? null
}

export async function getSalaryRules(): Promise<SalaryRule[]> {
  const me = await viewer()
  if (!me) return []
  const settings = await readSettings()
  const raw = settings?.extra?.salaryCommission
  if (!Array.isArray(raw)) return []
  return raw.filter((rule): rule is SalaryRule =>
    typeof rule === 'object' && rule !== null
    && typeof (rule as SalaryRule).id === 'string'
    && ((rule as SalaryRule).kind === 'per_client' || (rule as SalaryRule).kind === 'revenue_share')
    && typeof (rule as SalaryRule).percent === 'number'
  )
}

export async function saveSalaryRules(
  rules: SalaryRule[]
): Promise<{ success: true } | { success: false; error: string }> {
  const me = await viewer()
  if (me?.role !== 'owner') return { success: false, error: 'Проценты задаёт только владелец' }

  for (const rule of rules) {
    if (!Number.isFinite(rule.percent) || rule.percent < 0 || rule.percent > 100) {
      return { success: false, error: 'Процент должен быть от 0 до 100' }
    }
  }

  const admin = createAdminClient()
  const settings = await readSettings()
  if (!settings) return { success: false, error: 'Не найдены настройки компании' }

  const { error } = await admin
    .from('settings')
    .update({ extra: { ...settings.extra, salaryCommission: rules } })
    .eq('id', settings.id)
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard/salary')
  return { success: true }
}

// ─── Расчёт ──────────────────────────────────────────────────────────────────

export async function getSalaryCalculation(year: number, month: number): Promise<SalaryCalculation> {
  const me = await viewer()
  const empty: SalaryCalculation = { totalRevenue: 0, lines: [], payroll: 0, rules: [] }
  if (!me) return empty

  const admin = createAdminClient()
  const rules = await getSalaryRules()

  // Границы месяца по Asia/Bishkek (UTC+6 круглый год).
  const OFFSET_MS = 6 * 3600_000
  const from = new Date(Date.UTC(year, month - 1, 1) - OFFSET_MS).toISOString()
  const to = new Date(Date.UTC(year, month, 1) - OFFSET_MS).toISOString()

  const [{ data: emps }, { data: orders }, { data: wazzup }, { data: amo }] = await Promise.all([
    admin.from('employees').select('id, name, role').is('deleted_at', null).order('name'),
    admin
      .from('orders')
      .select('customer_phone, total_amount, created_at')
      .neq('status', 'cancelled')
      .is('deleted_at', null)
      .gte('created_at', from)
      .lt('created_at', to),
    admin.from('whatsapp_messages').select('phone, sent_by, created_at').not('sent_by', 'is', null),
    admin.from('chat_messages').select('chat_id, author_name, created_at').eq('sender', 'operator'),
  ])

  const employees = (emps ?? []) as { id: string; name: string; role: string }[]
  const idByName = new Map(employees.map((e) => [e.name.trim().toLowerCase(), e.id]))

  // Телефон → кто ответил последним.
  const ownerOfPhone = new Map<string, { employeeId: string; at: string }>()
  const claim = (phone: string, employeeId: string | undefined, at: string) => {
    if (!phone || !employeeId) return
    const current = ownerOfPhone.get(phone)
    if (!current || at > current.at) ownerOfPhone.set(phone, { employeeId, at })
  }

  for (const row of (wazzup ?? []) as { phone: string; sent_by: string; created_at: string }[]) {
    claim(phoneKey(row.phone), row.sent_by, row.created_at)
  }
  for (const row of (amo ?? []) as { chat_id: string; author_name: string | null; created_at: string }[]) {
    // chat_id из одних цифр — это номер (Green API). UUID-подобный chat_id —
    // чат amojo, с заказом его не сопоставить, пропускаем.
    if (!/^\d{9,}$/.test(String(row.chat_id))) continue
    claim(phoneKey(row.chat_id), idByName.get((row.author_name ?? '').trim().toLowerCase()), row.created_at)
  }

  let totalRevenue = 0
  const own = new Map<string, { clients: number; revenue: number }>()
  const countedClients = new Map<string, Set<string>>()

  for (const order of (orders ?? []) as { customer_phone: string | null; total_amount: number | null }[]) {
    const amount = Number(order.total_amount ?? 0)
    totalRevenue += amount

    const phone = phoneKey(order.customer_phone)
    const holder = phone ? ownerOfPhone.get(phone) : undefined
    if (!holder) continue

    const bucket = own.get(holder.employeeId) ?? { clients: 0, revenue: 0 }
    bucket.revenue += amount
    own.set(holder.employeeId, bucket)

    const seen = countedClients.get(holder.employeeId) ?? new Set<string>()
    seen.add(phone)
    countedClients.set(holder.employeeId, seen)
  }
  for (const [employeeId, seen] of countedClients) {
    const bucket = own.get(employeeId)
    if (bucket) bucket.clients = seen.size
  }

  return calculateSalaries({ rules, totalRevenue, employees, own })
}
