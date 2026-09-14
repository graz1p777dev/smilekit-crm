'use client'

// Вкладка «Конверсии и продажи»: период сверху, дальше продажи, диалоги,
// воронка и разрезы по клиентам. Все цифры считает сервер.

import { useState } from 'react'
import { Bot, UserRound } from 'lucide-react'
import type { AnalyticsPeriod, ConversionAnalytics } from '@/actions/analytics'
import { Bars, Card, Funnel, INK, INK_2, INK_3, LINE, SERIES, Split, Stat, money, num } from './viz'

const PERIODS: { key: AnalyticsPeriod; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'month', label: 'За месяц' },
  { key: 'year', label: 'За год' },
]

const GOLD = '#f5a623'

/** Спарклайн выручки: форма важнее точных значений, поэтому без осей. */
function Sparkline({ points }: { points: { date: string; revenue: number }[] }) {
  if (points.length < 2) return <p className="text-sm" style={{ color: INK_3 }}>Мало данных</p>
  const max = Math.max(...points.map((p) => p.revenue), 1)
  const W = 560
  const H = 90
  const step = W / (points.length - 1)
  const coords = points.map((p, i) => [i * step, H - (p.revenue / max) * (H - 8)] as const)
  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${W},${H} L0,${H} Z`
  const best = points.reduce((a, b) => (b.revenue > a.revenue ? b : a))

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 90 }} role="img"
        aria-label={`Выручка по дням за ${points.length} дней, максимум ${money(max)}`}>
        <path d={area} fill={SERIES[0]} opacity={0.10} />
        <path d={line} fill="none" stroke={SERIES[0]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="mt-1 flex justify-between text-[11px]" style={{ color: INK_3 }}>
        <span>{new Date(points[0].date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>
        <span>Лучший день — {new Date(best.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, {money(best.revenue)}</span>
        <span>сегодня</span>
      </div>
    </div>
  )
}

export default function ConversionAnalyticsView({ data }: { data: ConversionAnalytics }) {
  const [period, setPeriod] = useState<AnalyticsPeriod>('month')
  const stats = data[period]
  const served = stats.dialogsByBot + stats.dialogsByManager
  const botShare = served ? Math.round((stats.dialogsByBot / served) * 100) : 0

  return (
    <div className="flex flex-col gap-5 p-4 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold" style={{ color: INK }}>Аналитика конверсий</h1>
          <p className="mt-0.5 text-sm" style={{ color: INK_3 }}>
            Продажи, диалоги и кто их ведёт — бот или менеджер
          </p>
        </div>
        <div className="flex gap-1 rounded-xl p-1" style={{ background: '#fdfbfb', border: `1px solid ${LINE}` }}>
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
              style={period === p.key ? { background: GOLD, color: '#1b1517' } : { color: INK_3 }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))' }}>
        <Stat label="Выручка" value={money(stats.revenue)} tone="good" />
        <Stat label="Заказов" value={num(stats.orders)} />
        <Stat label="Коробок продано" value={num(stats.boxes)} />
        <Stat label="Средний чек" value={stats.avgCheck ? money(stats.avgCheck) : '—'} />
        <Stat label="Покупателей" value={num(stats.buyers)} />
        <Stat label="Диалогов" value={num(stats.dialogs)} />
        <Stat label="Конверсия в заказ" value={`${stats.conversion}%`} tone="warn" sub="из диалога в покупку" />
      </div>

      <Card title="Выручка по дням" hint="Последние 30 дней">
        <Sparkline points={data.daily} />
      </Card>

      <div className="grid gap-5 md:grid-cols-2">
        <Card title="Путь клиента" hint="Сколько доходит до каждого шага">
          <Funnel steps={[
            { label: 'Диалогов', value: data.year.dialogs },
            { label: 'Купили', value: data.year.buyers },
            { label: 'Купили повторно', value: data.repeat.repeatClients },
          ]} />
        </Card>

        <Card title="Кто обслуживает клиентов" hint="Диалог считается за менеджером, если в нём хоть раз ответил живой человек">
          {served === 0 ? (
            <p className="text-sm" style={{ color: INK_3 }}>Нет диалогов за период</p>
          ) : (
            <>
              <Split
                left={{ label: 'Бот', value: stats.dialogsByBot, color: SERIES[0] }}
                right={{ label: 'Менеджер', value: stats.dialogsByManager, color: SERIES[2] }}
              />
              <p className="mt-3 flex items-center gap-3 text-[11px]" style={{ color: INK_3 }}>
                <span className="flex items-center gap-1"><Bot size={12} /> бот ведёт {botShare}%</span>
                <span className="flex items-center gap-1"><UserRound size={12} /> менеджер {100 - botShare}%</span>
              </p>
            </>
          )}
        </Card>

        <Card title="Железные и обычные клиенты" hint="Железный — ни разу не покупал со скидкой">
          <Split
            left={{ label: 'Железные', value: data.clientQuality.iron, color: SERIES[1] }}
            right={{ label: 'Со скидкой', value: data.clientQuality.discounted, color: SERIES[2] }}
          />
          <p className="mt-3 text-xs" style={{ color: INK_2 }}>
            Платят полную цену — <strong>{data.clientQuality.ironShare}%</strong> покупателей.
          </p>
        </Card>

        <Card title="Сколько скидок дали" hint="По ступеням из базы знаний бота">
          <Bars
            items={data.discountTiers.map((tier) => ({
              label: tier.label,
              value: tier.orders,
              hint: tier.givenAway > 0
                ? `${num(tier.orders)} зак. · отдали ${money(tier.givenAway)}`
                : `${num(tier.orders)} зак.`,
            }))}
          />
        </Card>

        <Card title="Повторные продажи" hint="Заказы, которые у клиента не первые">
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
            <Stat label="Повторных заказов" value={num(data.repeat.repeatOrders)} sub={`${data.repeat.share}% от всех`} />
            <Stat label="Вернувшихся клиентов" value={num(data.repeat.repeatClients)} />
            <Stat label="Выручка с повторных" value={money(data.repeat.repeatRevenue)} tone="good" />
          </div>
        </Card>

        <Card title="Клиенты по городам" hint="Считаются люди, а не заказы">
          <Bars
            items={data.cities.slice(0, 8).map((city) => ({
              label: city.city,
              value: city.clients,
              hint: `${num(city.clients)} чел. · ${num(city.orders)} зак.`,
            }))}
          />
        </Card>

        <Card title="Каналы за год" hint="Диалоги, заказы и конверсия по каждому">
          <Bars
            items={data.channels.map((c) => ({
              label: c.label,
              value: c.dialogs,
              hint: `${num(c.dialogs)} диал. · ${num(c.orders)} зак. · ${c.conversion}%`,
            }))}
          />
        </Card>

        <Card title="Нагрузка менеджеров за год" hint="Сколько диалогов забрал себе каждый">
          <Bars items={data.managers.map((m) => ({ label: m.name, value: m.dialogs }))} />
        </Card>
      </div>
    </div>
  )
}
