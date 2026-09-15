import { createClient } from '@/lib/supabase/server'
import CalendarAnalytics from './CalendarAnalytics'

type SearchParams = Promise<{ month?: string }>

type DayAnalytics = {
  date: string
  fv: number
  sales: number
  revenue: number
  leads: number
  appeals: number
  adBudget: number
  activeCampaigns: number
  income: number
  expense: number
  events: number
  dailyPlan: number
}

function isMonth(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value))
}

export default async function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const now = new Date()
  const month = isMonth(params.month)
    ? params.month
    : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const [year, monthNumber] = month.split('-').map(Number)
  const daysInMonth = new Date(year, monthNumber, 0).getDate()
  const from = `${month}-01`
  const to = `${month}-${String(daysInMonth).padStart(2, '0')}`
  const supabase = await createClient()

  // marketing_daily_data не читаем: такой таблицы в базе нет (её не создаёт
  // ни одна миграция), а раздел «Маркетинг» удалён. Запрос каждый раз
  // возвращал ошибку, которую молча проглатывали, — поля рекламного бюджета
  // в календаре просто остаются нулевыми.
  const [activityResult, consultationsResult, financeResult, planResult] = await Promise.all([
    supabase.from('daily_activity').select('date, fv_fact, sales_fact, revenue_fact, leads_fact, appeals_fact').gte('date', from).lte('date', to),
    supabase.from('consultations').select('date, actual_status, status_after_fv, amount').gte('date', from).lte('date', to).is('deleted_at', null),
    supabase.from('finance_transactions').select('date, type, amount').gte('date', from).lte('date', to).is('deleted_at', null),
    supabase.from('company_plans').select('date_start, date_end, target_revenue').lte('date_start', to).gte('date_end', from),
  ])

  const facts = new Map<string, DayAnalytics>()
  const entry = (date: string) => {
    const existing = facts.get(date)
    if (existing) return existing
    const created: DayAnalytics = {
      date, fv: 0, sales: 0, revenue: 0, leads: 0, appeals: 0,
      adBudget: 0, activeCampaigns: 0, income: 0, expense: 0, events: 0, dailyPlan: 0,
    }
    facts.set(date, created)
    return created
  }

  const activityOverrides = new Map<string, { fv: boolean; sales: boolean; revenue: boolean }>()
  for (const row of activityResult.data ?? []) {
    const day = entry(row.date as string)
    activityOverrides.set(row.date as string, {
      fv: row.fv_fact !== null,
      sales: row.sales_fact !== null,
      revenue: row.revenue_fact !== null,
    })
    day.fv += Number(row.fv_fact) || 0
    day.sales += Number(row.sales_fact) || 0
    day.revenue += Number(row.revenue_fact) || 0
    day.leads += Number(row.leads_fact) || 0
    day.appeals += Number(row.appeals_fact) || 0
  }

  for (const row of consultationsResult.data ?? []) {
    const date = row.date as string
    const day = entry(date)
    const override = activityOverrides.get(date)
    // daily_activity — главный источник дневного факта. Если конкретная
    // метрика в нём не внесена, берём её из консультаций как честный fallback.
    if (!override?.fv) day.fv += row.actual_status ? 1 : 0
    const isSale = row.status_after_fv === 'Купила' || row.status_after_fv === 'Предоплата'
    if (isSale && !override?.sales) day.sales += 1
    if (isSale && !override?.revenue) {
      day.revenue += Number(row.amount) || 0
    }
  }

  for (const row of financeResult.data ?? []) {
    const day = entry(row.date as string)
    if (row.type === 'income') day.income += Number(row.amount) || 0
    if (row.type === 'expense') day.expense += Number(row.amount) || 0
  }

  for (const plan of planResult.data ?? []) {
    const planStart = new Date(`${plan.date_start}T00:00:00`)
    const planEnd = new Date(`${plan.date_end}T00:00:00`)
    const planDays = Math.max(1, Math.round((planEnd.getTime() - planStart.getTime()) / 86_400_000) + 1)
    const dailyPlan = (Number(plan.target_revenue) || 0) / planDays
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${month}-${String(day).padStart(2, '0')}`
      if (date >= String(plan.date_start) && date <= String(plan.date_end)) entry(date).dailyPlan += dailyPlan
    }
  }

  const data = Array.from({ length: daysInMonth }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`
    const day = entry(date)
    day.events = Number(day.fv > 0) + Number(day.sales > 0) + Number(day.adBudget > 0) + Number(day.income > 0 || day.expense > 0)
    return day
  })

  return <CalendarAnalytics month={month} days={data} />
}
