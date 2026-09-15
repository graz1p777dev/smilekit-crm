'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { validatePassword } from '@/lib/auth-validation'
import { recordAudit } from '@/actions/audit'
import type { Employee, Department } from '@/types'

// ─── getEmployees (admin — обходит RLS, нужен для архива) ─────────────────────

export async function getEmployees(includeArchived: boolean): Promise<{
  employees: Employee[]
  departments: Pick<Department, 'id' | 'name'>[]
  roles: { value: string; label: string }[]
  schedules: { value: string; label: string }[]
}> {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { employees: [], departments: [], roles: [], schedules: [] }

  const admin = createAdminClient()

  let query = admin.from('employees').select('*').order('name')
  if (!includeArchived) query = query.is('deleted_at', null)

  const [{ data: emps }, { data: depts }, { data: roleRows }, { data: scheduleRows }] = await Promise.all([
    query,
    admin.from('departments').select('id, name').eq('is_active', true).order('name'),
    admin.from('roles').select('name, label').is('deleted_at', null).order('created_at'),
    admin.from('work_schedules').select('name, description').eq('is_active', true).order('created_at'),
  ])

  return {
    employees: (emps as Employee[]) ?? [],
    departments: (depts as Pick<Department, 'id' | 'name'>[]) ?? [],
    roles: ((roleRows ?? []) as { name: string; label: string }[]).map(r => ({ value: r.name, label: r.label })),
    schedules: ((scheduleRows ?? []) as { name: string; description: string | null }[]).map(s => ({
      value: s.name,
      label: s.description ? `${s.name} — ${s.description}` : s.name,
    })),
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const EmployeeSchema = z.object({
  name:             z.string().min(2, 'Имя обязательно (мин. 2 символа)'),
  email:            z.string().email('Некорректный email'),
  phone:            z.string().nullable().optional(),
  role:             z.string().min(1, 'Роль обязательна'),
  department_id:    z.string().uuid().nullable().optional(),
  hire_date:        z.string().nullable().optional(),
  birth_date:       z.string().nullable().optional(),
  base_salary:      z.number().min(0).default(0),
  kpi_coefficient:  z.number().min(0).default(1.0).optional(),
  schedule_type:    z.string().min(1).default('5/2'),
  work_start_time:  z.string().default('09:00'),
  work_end_time:    z.string().default('18:00'),
  status:           z.enum(['active', 'probation', 'archived']).default('active'),
  notes:            z.string().nullable().optional(),
  // Пароль нужен только при создании — при обновлении передаётся как пустая строка
  initial_password: z.string().optional(),
})

export type EmployeeFormData = z.infer<typeof EmployeeSchema>
export type ActionResult = { success: true } | { success: false; error: string }

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function requireOwner(): Promise<boolean> {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return false
  const { data } = await supabase
    .from('employees')
    .select('role')
    .eq('user_id', session.user.id)
    .single()
  return data?.role === 'owner'
}

// ─── createEmployee ───────────────────────────────────────────────────────────

export async function createEmployee(data: EmployeeFormData): Promise<ActionResult> {
  if (!await requireOwner()) return { success: false, error: 'Недостаточно прав' }

  const parsed = EmployeeSchema.safeParse(data)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }

  // Валидация пароля — обязателен при создании
  const password = parsed.data.initial_password ?? ''
  if (!password) return { success: false, error: 'Задайте начальный пароль для сотрудника' }
  const pwErr = validatePassword(password)
  if (pwErr) return { success: false, error: pwErr }

  const admin = createAdminClient()

  // Проверяем уникальность email в employees
  const { data: existing } = await admin
    .from('employees')
    .select('id')
    .eq('email', parsed.data.email)
    .is('deleted_at', null)
    .maybeSingle()
  if (existing) return { success: false, error: 'Сотрудник с таким email уже существует' }

  // 1. Создаём auth.users через service role (email сразу подтверждён)
  const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
    email:         parsed.data.email,
    password,
    email_confirm: true,
  })

  if (authErr || !authUser?.user) {
    console.error('[createEmployee] auth.admin.createUser:', authErr?.message)
    if (authErr?.message?.includes('already been registered')) {
      return { success: false, error: 'Пользователь с таким email уже существует в системе' }
    }
    return { success: false, error: 'Ошибка создания аккаунта' }
  }

  // 2. Создаём запись в employees с привязанным user_id
  const payload = {
    user_id:         authUser.user.id,
    name:            parsed.data.name,
    email:           parsed.data.email,
    phone:           parsed.data.phone ?? null,
    role:            parsed.data.role,
    department_id:   parsed.data.department_id ?? null,
    hire_date:       parsed.data.hire_date ?? null,
    birth_date:      parsed.data.birth_date ?? null,
    base_salary:     parsed.data.base_salary,
    kpi_coefficient: parsed.data.kpi_coefficient,
    schedule_type:   parsed.data.schedule_type,
    work_start_time: parsed.data.work_start_time,
    work_end_time:   parsed.data.work_end_time,
    status:          parsed.data.status,
    notes:           parsed.data.notes ?? null,
  }

  const { error: empErr } = await admin.from('employees').insert(payload)
  if (empErr) {
    console.error('[createEmployee] insert:', empErr.code, empErr.message)
    // Откат: удаляем auth-пользователя чтобы не было orphan
    await admin.auth.admin.deleteUser(authUser.user.id)
    if (empErr.code === '23505') return { success: false, error: 'Email уже занят' }
    return { success: false, error: 'Ошибка создания сотрудника' }
  }

  await recordAudit({ action: 'create', resourceType: 'employee', summary: `Добавлен сотрудник ${parsed.data.name}` })
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── updateEmployee ───────────────────────────────────────────────────────────

export async function updateEmployee(id: string, data: EmployeeFormData): Promise<ActionResult> {
  if (!await requireOwner()) return { success: false, error: 'Недостаточно прав' }

  const parsed = EmployeeSchema.safeParse(data)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }

  const admin = createAdminClient()

  // Проверяем уникальность email (кроме текущего)
  const { data: existing } = await admin
    .from('employees')
    .select('id')
    .eq('email', parsed.data.email)
    .is('deleted_at', null)
    .neq('id', id)
    .maybeSingle()

  if (existing) return { success: false, error: 'Сотрудник с таким email уже существует' }

  const payload = {
    name:            parsed.data.name,
    email:           parsed.data.email,
    phone:           parsed.data.phone ?? null,
    role:            parsed.data.role,
    department_id:   parsed.data.department_id ?? null,
    hire_date:       parsed.data.hire_date ?? null,
    birth_date:      parsed.data.birth_date ?? null,
    base_salary:     parsed.data.base_salary,
    kpi_coefficient: parsed.data.kpi_coefficient,
    schedule_type:   parsed.data.schedule_type,
    work_start_time: parsed.data.work_start_time,
    work_end_time:   parsed.data.work_end_time,
    status:          parsed.data.status,
    notes:           parsed.data.notes ?? null,
  }

  const { error } = await admin
    .from('employees')
    .update(payload)
    .eq('id', id)
    .is('deleted_at', null)

  if (error) {
    console.error('[updateEmployee]', error.code, error.message)
    return { success: false, error: 'Ошибка обновления сотрудника' }
  }

  await recordAudit({ action: 'update', resourceType: 'employee', resourceId: id, summary: `Изменён сотрудник ${parsed.data.name}` })
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── archiveEmployee (soft delete) ───────────────────────────────────────────

export async function archiveEmployee(id: string): Promise<ActionResult> {
  if (!await requireOwner()) return { success: false, error: 'Недостаточно прав' }

  const admin = createAdminClient()
  const { data: emp } = await admin.from('employees').select('name, deleted_at, status').eq('id', id).maybeSingle()
  if (!emp) return { success: false, error: 'Сотрудник не найден' }
  if (emp.deleted_at || emp.status === 'archived') return { success: false, error: 'Сотрудник уже уволен' }
  const { error } = await admin
    .from('employees')
    .update({ deleted_at: new Date().toISOString(), status: 'archived' })
    .eq('id', id)
    .is('deleted_at', null)

  if (error) {
    console.error('[archiveEmployee]', error.code, error.message)
    return { success: false, error: 'Ошибка увольнения сотрудника' }
  }

  await recordAudit({ action: 'update', resourceType: 'employee', resourceId: id, summary: `Уволен сотрудник ${emp?.name ?? ''}` })
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── restoreEmployee ──────────────────────────────────────────────────────────

export async function restoreEmployee(id: string): Promise<ActionResult> {
  if (!await requireOwner()) return { success: false, error: 'Недостаточно прав' }

  const admin = createAdminClient()
  const { data: emp } = await admin.from('employees').select('name').eq('id', id).maybeSingle()
  const { error } = await admin
    .from('employees')
    .update({ deleted_at: null, status: 'active' })
    .eq('id', id)
    .not('deleted_at', 'is', null)

  if (error) {
    console.error('[restoreEmployee]', error.code, error.message)
    return { success: false, error: 'Ошибка восстановления сотрудника' }
  }

  await recordAudit({ action: 'update', resourceType: 'employee', resourceId: id, summary: `Восстановлен сотрудник ${emp?.name ?? ''}` })
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── upsertEmployeeKpi ────────────────────────────────────────────────────────

export interface KpiPlanFormData {
  plan_fv:        number | null
  plan_sales:     number | null
  plan_revenue:   number | null
  plan_appeals:   number | null
  plan_leads:     number | null
  plan_nv:        number | null
  plan_work_days: number | null
}

export async function upsertEmployeeKpi(
  employeeId: string,
  year: number,
  month: number,
  data: KpiPlanFormData,
): Promise<ActionResult> {
  if (!await requireOwner()) return { success: false, error: 'Недостаточно прав' }

  const admin = createAdminClient()

  const { error: upsertErr } = await admin
    .from('employee_kpi')
    .upsert(
      {
        employee_id:   employeeId,
        period_year:   year,
        period_month:  month,
        plan_fv:       data.plan_fv,
        plan_sales:    data.plan_sales,
        plan_revenue:  data.plan_revenue,
        plan_appeals:  data.plan_appeals,
        plan_leads:    data.plan_leads,
        plan_nv:       data.plan_nv,
        plan_work_days:data.plan_work_days,
        created_by:    null,
      },
      { onConflict: 'employee_id,period_year,period_month' }
    )

  if (upsertErr) {
    console.error('[upsertEmployeeKpi]', upsertErr.message)
    return { success: false, error: 'Ошибка сохранения KPI-планов' }
  }

  // Пересчитываем sales_plan_weekly чтобы kpi_pct обновился сразу
  const { error: rpcErr } = await admin.rpc('recalculate_decomposition', {
    p_employee_id: employeeId,
    p_year:        year,
    p_month:       month,
  })
  if (rpcErr) {
    console.error('[upsertEmployeeKpi] recalculate_decomposition failed:', rpcErr.message)
  }

  // Инвалидируем кэш — следующий getEmployeesData получит свежие данные
  const { globalCache } = await import('@/lib/data/cache/MemoryCache')
  globalCache.invalidate(`employees:${year}:${month - 1}`)
  globalCache.invalidate(`employees:${year}:${month}`)

  const { data: kpiEmp } = await admin.from('employees').select('name').eq('id', employeeId).maybeSingle()
  await recordAudit({
    action: 'update',
    resourceType: 'employee_kpi',
    resourceId: employeeId,
    summary: `Изменён KPI-план ${kpiEmp?.name ?? ''} на ${String(month).padStart(2, '0')}.${year}`,
  })
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── getEmployeeKpiPlan ───────────────────────────────────────────────────────

export async function getEmployeeKpiPlan(
  employeeId: string,
  year: number,
  month: number,
): Promise<KpiPlanFormData | null> {
  if (!await requireOwner()) return null

  const admin = createAdminClient()
  const { data } = await admin
    .from('employee_kpi')
    .select('plan_fv,plan_sales,plan_revenue,plan_appeals,plan_leads,plan_nv,plan_work_days')
    .eq('employee_id', employeeId)
    .eq('period_year', year)
    .eq('period_month', month)
    .maybeSingle()

  if (!data) return null
  return data as KpiPlanFormData
}

// ─── Сколько лидов обслужил сотрудник ────────────────────────────────────────

/**
 * Считает, скольким РАЗНЫМ клиентам сотрудник ответил из CRM.
 *
 * «Ответил из CRM» — это исходящее сообщение, отправленное его руками через
 * интерфейс (страница клиентов, карточка сделки, чат). В базе такие следы
 * двух видов:
 *   whatsapp_messages.sent_by  — прямая ссылка на сотрудника (канал Wazzup);
 *   chat_messages            — sender='operator' + author_name, имя сюда
 *                                кладут sendCustomerMessage и sendDealMessage.
 * Ответы бота (sender='bot') не считаются — они ничьи.
 *
 * Ключ результата — id сотрудника, значение — число разных чатов.
 */
export async function getEmployeeLeadReplies(): Promise<Record<string, number>> {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return {}

  const admin = createAdminClient()

  const [{ data: emps }, { data: wazzup }, { data: amo }] = await Promise.all([
    admin.from('employees').select('id, name'),
    admin.from('whatsapp_messages').select('phone, sent_by').not('sent_by', 'is', null),
    admin.from('chat_messages').select('chat_id, author_name').eq('sender', 'operator'),
  ])

  const employees = (emps ?? []) as { id: string; name: string }[]
  // Имя → id: в chat_messages сотрудник записан именем, а не ссылкой.
  const idByName = new Map(employees.map((e) => [e.name.trim().toLowerCase(), e.id]))
  const chatsByEmployee = new Map<string, Set<string>>()

  const add = (employeeId: string | null | undefined, chat: string) => {
    if (!employeeId || !chat) return
    const set = chatsByEmployee.get(employeeId) ?? new Set<string>()
    set.add(chat)
    chatsByEmployee.set(employeeId, set)
  }

  for (const row of (wazzup ?? []) as { phone: string; sent_by: string | null }[]) {
    add(row.sent_by, row.phone.replace(/\D/g, '').slice(-9))
  }
  for (const row of (amo ?? []) as { chat_id: string; author_name: string | null }[]) {
    add(idByName.get((row.author_name ?? '').trim().toLowerCase()), String(row.chat_id))
  }

  const result: Record<string, number> = {}
  for (const employee of employees) {
    result[employee.id] = chatsByEmployee.get(employee.id)?.size ?? 0
  }
  return result
}
