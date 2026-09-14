'use client'

// Зарплата по процентам: владелец задаёт правила, страница показывает, кому
// сколько выходит за выбранный месяц.

import { useCallback, useEffect, useState, useTransition } from 'react'
import { ChevronLeft, ChevronRight, Percent, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getSalaryCalculation, saveSalaryRules } from '@/actions/salary'
import { recoverFromStaleAction } from '@/lib/stale-action'
import {
  SALARY_RULE_LABELS,
  type SalaryCalculation,
  type SalaryRule,
  type SalaryRuleKind,
} from '@/lib/salary/commission'

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']

const money = (value: number) => `${Math.round(value).toLocaleString('ru-RU')} сом`

export default function SalaryClient({
  employees,
  isOwner,
}: {
  employees: { id: string; name: string }[]
  isOwner: boolean
}) {
  const [current, setCurrent] = useState(() => new Date())
  const [data, setData] = useState<SalaryCalculation | null>(null)
  const [rules, setRules] = useState<SalaryRule[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, startSaving] = useTransition()

  const year = current.getFullYear()
  const month = current.getMonth() + 1

  const load = useCallback(() => {
    getSalaryCalculation(year, month)
      .then((result) => {
        setData(result)
        setRules(result.rules)
      })
      .catch((err: unknown) => {
        if (recoverFromStaleAction(err)) return
        toast.error('Не удалось посчитать зарплату')
      })
      .finally(() => setLoading(false))
  }, [year, month])

  useEffect(() => {
    const timer = setTimeout(() => { setLoading(true); load() }, 0)
    return () => clearTimeout(timer)
  }, [load])

  const addRule = (kind: SalaryRuleKind) => {
    setRules((prev) => [...prev, {
      id: `${kind}-${Date.now()}`,
      kind,
      percent: 5,
      employeeId: null,
    }])
  }

  const patchRule = (id: string, patch: Partial<SalaryRule>) => {
    setRules((prev) => prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)))
  }

  const save = () => {
    startSaving(async () => {
      const result = await saveSalaryRules(rules)
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success('Проценты сохранены')
      load()
    })
  }

  return (
    <div className="p-5 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#1b1517' }}>Зарплата</h1>
          <p className="mt-1 text-sm" style={{ color: '#7d7174' }}>
            Начисления по процентам, которые задаёт владелец.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => setCurrent(new Date(year, month - 2, 1))} aria-label="Предыдущий месяц">
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-40 text-center font-semibold capitalize">{MONTHS[month - 1]} {year}</span>
          <Button variant="outline" size="icon" onClick={() => setCurrent(new Date(year, month, 1))} aria-label="Следующий месяц">
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border bg-white p-5" style={{ borderColor: '#ece5e5' }}>
          <p className="text-sm" style={{ color: '#7d7174' }}>Выручка за месяц</p>
          <p className="mt-1 text-3xl font-bold" style={{ color: '#047857' }}>{money(data?.totalRevenue ?? 0)}</p>
        </div>
        <div className="rounded-2xl border bg-white p-5" style={{ borderColor: '#ece5e5' }}>
          <p className="text-sm" style={{ color: '#7d7174' }}>К выплате сотрудникам</p>
          <p className="mt-1 text-3xl font-bold" style={{ color: '#5115a4' }}>{money(data?.payroll ?? 0)}</p>
        </div>
      </div>

      {/* Правила — только владелец */}
      {isOwner && (
        <div className="mt-5 rounded-2xl border bg-white p-5" style={{ borderColor: '#ece5e5' }}>
          <div className="flex items-center gap-2">
            <Percent className="size-4" style={{ color: '#5115a4' }} />
            <h2 className="font-semibold" style={{ color: '#1b1517' }}>Проценты</h2>
          </div>

          <div className="mt-4 space-y-3">
            {rules.length === 0 && (
              <p className="text-sm" style={{ color: '#7d7174' }}>
                Правил пока нет — добавьте процент, и начисления посчитаются сами.
              </p>
            )}
            {rules.map((rule) => (
              <div key={rule.id} className="flex flex-wrap items-center gap-2 rounded-xl p-3" style={{ background: '#fdfbfb' }}>
                <span className="text-sm font-medium" style={{ color: '#1b1517', minWidth: 230 }}>
                  {SALARY_RULE_LABELS[rule.kind]}
                </span>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step="0.5"
                  value={rule.percent}
                  onChange={(e) => patchRule(rule.id, { percent: Number(e.target.value) })}
                  className="w-24"
                />
                <span className="text-sm" style={{ color: '#7d7174' }}>%</span>
                <select
                  value={rule.employeeId ?? 'all'}
                  onChange={(e) => patchRule(rule.id, { employeeId: e.target.value === 'all' ? null : e.target.value })}
                  className="h-9 rounded-xl border px-3 text-[13px] outline-none"
                  style={{ borderColor: '#ece5e5', color: '#4e4560' }}
                >
                  <option value="all">всем сотрудникам</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.name}</option>
                  ))}
                </select>
                <button
                  onClick={() => setRules((prev) => prev.filter((r) => r.id !== rule.id))}
                  className="ml-auto rounded-lg p-1.5"
                  style={{ color: '#b91c1c' }}
                  title="Убрать правило"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => addRule('per_client')}>
              <Plus className="size-4" /> Процент за своих клиентов
            </Button>
            <Button variant="outline" size="sm" onClick={() => addRule('revenue_share')}>
              <Plus className="size-4" /> Процент от всей выручки
            </Button>
            <Button size="sm" className="ml-auto" onClick={save} disabled={saving}>
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </Button>
          </div>

          <p className="mt-3 text-xs leading-relaxed" style={{ color: '#7d7174' }}>
            Клиент закрепляется за тем, кто ответил ему последним, — так одна и та же
            выручка не попадёт в процент сразу нескольким. Персональный процент
            перекрывает общий: если у сотрудника задан свой, правило «всем» на него
            уже не действует.
          </p>
        </div>
      )}

      {/* Начисления */}
      <div className="mt-5 overflow-x-auto rounded-2xl border bg-white" style={{ borderColor: '#ece5e5' }}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase" style={{ background: '#faf8f7', color: '#6b6063' }}>
            <tr>
              <th className="px-4 py-3">Сотрудник</th>
              <th className="px-4 py-3 text-right">Своих клиентов</th>
              <th className="px-4 py-3 text-right">Выручка по ним</th>
              <th className="px-4 py-3 text-right">За клиентов</th>
              <th className="px-4 py-3 text-right">От выручки</th>
              <th className="px-4 py-3 text-right">Итого</th>
            </tr>
          </thead>
          <tbody>
            {(data?.lines ?? []).map((line) => (
              <tr key={line.employeeId} style={{ borderTop: '1px solid #f0eaea' }}>
                <td className="px-4 py-3 font-medium" style={{ color: '#1b1517' }}>
                  {line.name}
                  <span className="ml-2 text-xs" style={{ color: '#7d7174' }}>{line.role}</span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{line.clients}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(line.ownRevenue)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(line.perClientAmount)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{money(line.revenueShareAmount)}</td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums" style={{ color: '#5115a4' }}>
                  {money(line.total)}
                </td>
              </tr>
            ))}
            {!loading && (data?.lines.length ?? 0) === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center" style={{ color: '#7d7174' }}>
                  Сотрудников нет
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {loading && <p className="p-6 text-center" style={{ color: '#7d7174' }}>Считаем…</p>}
      </div>
    </div>
  )
}
