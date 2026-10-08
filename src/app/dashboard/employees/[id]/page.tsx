import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/admin'
import { ArrowLeft, User, Mail, Phone, Calendar, Briefcase, TrendingUp, Wallet } from 'lucide-react'

// ─── Типы ────────────────────────────────────────────────────────────────────

interface RawEmployee {
  id: string; name: string; email: string; phone: string | null
  role: string; status: string; hire_date: string | null; birth_date: string | null
  base_salary: number; kpi_coefficient: number; schedule_type: string
  work_start_time: string; work_end_time: string; notes: string | null
  deleted_at: string | null
  departments: { name: string } | null
}

interface RawDecomp {
  total_fv_plan: number; total_fv_fact: number
  total_sales_plan: number; total_sales_fact: number
  total_revenue_plan: number; total_revenue_fact: number
  kpi_pct: number
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Владелец', rop: 'РОП', mp: 'МП', lmai: 'ЛМАИ', accountant: 'Бухгалтер',
}
const STATUS_LABELS: Record<string, { label: string; bg: string; color: string }> = {
  active:    { label: 'Активный',       bg: '#dcfce7', color: '#166534' },
  probation: { label: 'Испытательный',  bg: '#fef9c3', color: '#854d0e' },
  archived:  { label: 'Уволен',         bg: '#fdfbfb', color: '#6b7280' },
}

function fmtDate(s: string | null) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
}

function fmtMoney(v: number) {
  if (v === 0) return '—'
  return `${v.toLocaleString('ru-RU')} сом`
}

function kpiColor(pct: number) {
  if (pct >= 100) return '#166534'
  if (pct >= 80)  return '#854d0e'
  return '#5115a4'
}
function kpiBg(pct: number) {
  if (pct >= 100) return '#dcfce7'
  if (pct >= 80)  return '#fef9c3'
  return '#fee2e2'
}

// ─── Сервер-компонент ─────────────────────────────────────────────────────────

export default async function EmployeeCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const admin = createAdminClient()
  const now   = new Date()
  const year  = now.getFullYear()
  const month = now.getMonth() + 1   // Supabase хранит как SMALLINT 1–12

  const [empRes, decompRes, kpiPlanRes] = await Promise.all([
    admin
      .from('employees')
      .select('id,name,email,phone,role,status,hire_date,birth_date,base_salary,kpi_coefficient,schedule_type,work_start_time,work_end_time,notes,deleted_at,departments(name)')
      .eq('id', id)
      .single(),
    admin
      .from('sales_plan_weekly')
      .select('total_fv_plan,total_fv_fact,total_sales_plan,total_sales_fact,total_revenue_plan,total_revenue_fact,kpi_pct')
      .eq('employee_id', id)
      .eq('period_year', year)
      .eq('period_month', month)
      .maybeSingle(),
    admin
      .from('employee_kpi')
      .select('plan_fv,plan_sales,plan_revenue,plan_work_days')
      .eq('employee_id', id)
      .eq('period_year', year)
      .eq('period_month', month)
      .maybeSingle(),
  ])

  if (empRes.error || !empRes.data) notFound()

  const emp    = empRes.data as unknown as RawEmployee
  const decomp = decompRes.data as unknown as RawDecomp | null
  const plan   = kpiPlanRes.data

  const kpiPct    = Math.round(decomp?.kpi_pct ?? 0)
  const bonus     = emp.base_salary > 0
    ? Math.round(emp.base_salary * emp.kpi_coefficient * Math.min(kpiPct / 100, 1.5))
    : 0
  const totalSalary = emp.base_salary + bonus
  const statusInfo  = STATUS_LABELS[emp.status] ?? STATUS_LABELS.active

  const deptName = (emp.departments as unknown as { name: string } | null)?.name ?? null

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#fdfbfb' }}>
      {/* Header */}
      <div className="px-6 py-4 flex items-center gap-4" style={{ backgroundColor: '#ffffff', borderBottom: '1px solid #ece5e5' }}>
        <Link
          href="/dashboard/employees"
          className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
          style={{ backgroundColor: '#5115a4' }}
        >
          <ArrowLeft size={16} color="#ffffff" />
        </Link>
        <div>
          <div className="font-semibold text-base" style={{ color: '#1b1517' }}>{emp.name}</div>
          <div className="text-xs" style={{ color: '#7d7174' }}>
            {ROLE_LABELS[emp.role] ?? emp.role}
            {deptName && ` · ${deptName}`}
          </div>
        </div>
        <span
          className="ml-auto px-3 py-1 rounded-full text-xs font-medium"
          style={{ backgroundColor: statusInfo.bg, color: statusInfo.color }}
        >
          {statusInfo.label}
        </span>
      </div>

      <div className="p-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Личные данные */}
        <div className="rounded-2xl p-5" style={{ backgroundColor: '#ffffff' }}>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-xl font-bold" style={{ backgroundColor: '#faf8f7', color: '#5115a4' }}>
              {emp.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
            </div>
            <div>
              <div className="font-semibold" style={{ color: '#1b1517' }}>{emp.name}</div>
              <div className="text-xs" style={{ color: '#7d7174' }}>{ROLE_LABELS[emp.role] ?? emp.role}</div>
            </div>
          </div>

          <div className="space-y-3">
            <InfoRow icon={<Mail size={14} />}    label="Email"    value={emp.email} />
            <InfoRow icon={<Phone size={14} />}   label="Телефон"  value={emp.phone ?? '—'} />
            <InfoRow icon={<Calendar size={14} />} label="Дата приёма"  value={fmtDate(emp.hire_date)} />
            <InfoRow icon={<Calendar size={14} />} label="Дата рождения" value={fmtDate(emp.birth_date)} />
            <InfoRow icon={<Briefcase size={14} />} label="График"  value={`${emp.schedule_type}  ${emp.work_start_time}–${emp.work_end_time}`} />
            {deptName && <InfoRow icon={<User size={14} />} label="Отдел" value={deptName} />}
          </div>

          {emp.notes && (
            <div className="mt-4 p-3 rounded-xl text-sm" style={{ backgroundColor: '#fdfbfb', color: '#1b1517' }}>
              {emp.notes}
            </div>
          )}
        </div>

        {/* KPI текущего периода */}
        <div className="rounded-2xl p-5" style={{ backgroundColor: '#ffffff' }}>
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp size={16} style={{ color: '#5115a4' }} />
            <div className="font-semibold text-sm" style={{ color: '#1b1517' }}>
              KPI — {new Date(year, month - 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}
            </div>
          </div>

          <div className="space-y-4">
            <KpiRow label="Первичные визиты (ФВ)" fact={decomp?.total_fv_fact ?? 0} plan={plan?.plan_fv ?? 0} />
            <KpiRow label="Продажи"                fact={decomp?.total_sales_fact ?? 0} plan={plan?.plan_sales ?? 0} />
            <KpiRow label="Выручка"                fact={decomp?.total_revenue_fact ?? 0} plan={plan?.plan_revenue ?? 0} isMoney />
          </div>

          {/* Итоговый % */}
          <div className="mt-5 p-4 rounded-xl flex items-center justify-between" style={{ backgroundColor: kpiBg(kpiPct) }}>
            <div className="font-medium text-sm" style={{ color: kpiColor(kpiPct) }}>Выполнение KPI</div>
            <div className="text-2xl font-bold" style={{ color: kpiColor(kpiPct) }}>{kpiPct}%</div>
          </div>

          <div className="mt-2 h-2 rounded-full" style={{ backgroundColor: '#ebebee' }}>
            <div className="h-2 rounded-full transition-all" style={{ width: `${Math.min(kpiPct, 100)}%`, backgroundColor: kpiColor(kpiPct) }} />
          </div>
        </div>

        {/* Расчёт зарплаты */}
        <div className="rounded-2xl p-5" style={{ backgroundColor: '#ffffff' }}>
          <div className="flex items-center gap-2 mb-4">
            <Wallet size={16} style={{ color: '#5115a4' }} />
            <div className="font-semibold text-sm" style={{ color: '#1b1517' }}>Расчёт зарплаты</div>
          </div>

          <div className="space-y-3">
            <SalaryRow label="Оклад"              value={fmtMoney(emp.base_salary)} />
            <SalaryRow label="Коэффициент KPI"    value={`× ${emp.kpi_coefficient}`} />
            <SalaryRow label="Выполнение KPI"     value={`${kpiPct}%`} accent={kpiColor(kpiPct)} />
            <div className="my-3" style={{ height: 1, backgroundColor: '#ebebee' }} />
            <SalaryRow label="Бонус"              value={fmtMoney(bonus)} accent={bonus > 0 ? '#166534' : undefined} />
            <div className="mt-4 p-4" style={{ borderRadius: 18, backgroundColor: '#f1ebfa', border: '1px solid #d9c8ef' }}>
              <div className="text-xs mb-1" style={{ color: '#6b6063' }}>Итоговая зарплата</div>
              <div className="text-2xl font-bold" style={{ color: '#5115a4' }}>{fmtMoney(totalSalary)}</div>
              {emp.base_salary > 0 && (
                <div className="text-xs mt-1" style={{ color: '#6b6063' }}>
                  оклад {fmtMoney(emp.base_salary)} + бонус {fmtMoney(bonus)}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <div className="mt-0.5" style={{ color: '#7d7174' }}>{icon}</div>
      <div>
        <div className="text-xs" style={{ color: '#7d7174' }}>{label}</div>
        <div className="text-sm" style={{ color: '#1b1517' }}>{value}</div>
      </div>
    </div>
  )
}

function KpiRow({ label, fact, plan, isMoney }: { label: string; fact: number; plan: number; isMoney?: boolean }) {
  const pct  = plan > 0 ? Math.min(Math.round((fact / plan) * 100), 200) : 0
  const fmt  = (v: number) => isMoney ? `${v.toLocaleString('ru-RU')} сом` : String(v)
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span style={{ color: '#7d7174' }}>{label}</span>
        <span style={{ color: '#1b1517' }}>
          <span className="font-medium">{fmt(fact)}</span>
          {plan > 0 && <span style={{ color: '#7d7174' }}> / {fmt(plan)}</span>}
        </span>
      </div>
      <div className="h-1.5 rounded-full" style={{ backgroundColor: '#ebebee' }}>
        <div className="h-1.5 rounded-full" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: '#5115a4' }} />
      </div>
    </div>
  )
}

function SalaryRow({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm" style={{ color: '#7d7174' }}>{label}</span>
      <span className="text-sm font-medium" style={{ color: accent ?? '#1b1517' }}>{value}</span>
    </div>
  )
}
