// Расчёт процентов сотрудникам.
//
// Две схемы, обе задаёт владелец:
//   per_client    — процент от выручки по клиентам, которых сотрудник обслужил;
//   revenue_share — процент от всей выручки компании за месяц.
// Правило либо адресное (конкретному сотруднику), либо общее (employeeId = null
// — действует на каждого активного сотрудника).

export type SalaryRuleKind = 'per_client' | 'revenue_share'

export interface SalaryRule {
  id: string
  kind: SalaryRuleKind
  /** Процент, 0–100. */
  percent: number
  /** null — правило действует на всех сотрудников. */
  employeeId: string | null
}

export const SALARY_RULE_LABELS: Record<SalaryRuleKind, string> = {
  per_client: 'процент с выручки по своим клиентам',
  revenue_share: 'процент от всей выручки',
}

/** Строка расчёта по одному сотруднику за период. */
export interface SalaryLine {
  employeeId: string
  name: string
  role: string
  /** Сколько клиентов закреплено за сотрудником (он отвечал последним). */
  clients: number
  /** Выручка по этим клиентам. */
  ownRevenue: number
  /** Начислено по схеме per_client. */
  perClientAmount: number
  /** Начислено по схеме revenue_share. */
  revenueShareAmount: number
  total: number
}

export interface SalaryCalculation {
  /** Вся выручка компании за период (отменённые заказы не в счёт). */
  totalRevenue: number
  lines: SalaryLine[]
  /** Сумма всех начислений — сколько всего придётся выплатить. */
  payroll: number
  rules: SalaryRule[]
}

const round = (value: number) => Math.round(value)

export function calculateSalaries(input: {
  rules: SalaryRule[]
  totalRevenue: number
  employees: { id: string; name: string; role: string }[]
  /** employeeId → { clients, revenue } по закреплённым за ним клиентам. */
  own: Map<string, { clients: number; revenue: number }>
}): SalaryCalculation {
  const { rules, totalRevenue, employees, own } = input

  const lines = employees.map((employee): SalaryLine => {
    const mine = own.get(employee.id) ?? { clients: 0, revenue: 0 }
    // Адресное правило перекрывает общее: если владелец завёл персональный
    // процент, общий на этого сотрудника уже не действует — иначе он получил
    // бы и то и другое, чего никто не имеет в виду, задавая персональный.
    const applicable = (kind: SalaryRuleKind): SalaryRule | null => {
      const personal = rules.find((r) => r.kind === kind && r.employeeId === employee.id)
      if (personal) return personal
      return rules.find((r) => r.kind === kind && r.employeeId === null) ?? null
    }

    const perClientRule = applicable('per_client')
    const revenueRule = applicable('revenue_share')

    const perClientAmount = perClientRule ? round(mine.revenue * perClientRule.percent / 100) : 0
    const revenueShareAmount = revenueRule ? round(totalRevenue * revenueRule.percent / 100) : 0

    return {
      employeeId: employee.id,
      name: employee.name,
      role: employee.role,
      clients: mine.clients,
      ownRevenue: mine.revenue,
      perClientAmount,
      revenueShareAmount,
      total: perClientAmount + revenueShareAmount,
    }
  })

  return {
    totalRevenue,
    lines: lines.sort((a, b) => b.total - a.total),
    payroll: lines.reduce((sum, line) => sum + line.total, 0),
    rules,
  }
}
