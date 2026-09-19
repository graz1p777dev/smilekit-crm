'use client'

// Вкладка «Покупки»: заказы за период из таблицы orders. Где в заказе нет
// суммы или количества — так и пишем, ничего не досчитываем.

import { useEffect, useState } from 'react'
import { BarChart3, MapPin, Package, Receipt, Repeat, ShoppingBag, Users, Wallet, Warehouse } from 'lucide-react'
import { getPurchasesAnalytics, type PurchasesAnalytics } from '@/lib/analytics/client-api'
import { getWhatsappSettings } from '@/actions/whatsapp-settings'
import { daysOf, type PeriodInput } from '@/lib/analytics/period'
import { recoverFromStaleAction } from '@/lib/stale-action'
import { useAnalyticsData, useReportStamp, type Stamp } from './useAnalyticsData'
import ReceiptsCard from './ReceiptsCard'
import {
  Bars, Card, EmptyState, ErrorState, INK, INK_2, INK_3, Kpi, KpiGrid, LINE, Lead, SERIES, TabBody, TabSkeleton, money, num,
} from './viz'

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'short' })

const dayLong = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long' })

/** Шаг сетки: 1/2/5 × 10ⁿ, три деления покрывают максимум. */
function niceStep(max: number) {
  const raw = Math.max(1, max) / 3
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow
  return Math.max(1, Math.ceil(step))
}

function DailyChart({ data }: { data: PurchasesAnalytics }) {
  const [active, setActive] = useState<number | null>(null)
  const byDay = new Map(data.daily.map((d) => [d.day, d]))
  const days = daysOf(data.range).map((day) => byDay.get(day) ?? { day, orders: 0, revenue: 0 })
  const max = Math.max(0, ...days.map((d) => d.orders))
  const step = niceStep(max)
  const top = step * 3
  const ticks = [0, step, step * 2, step * 3]
  const peak = max > 0 ? days.findIndex((d) => d.orders === max) : -1
  const hovered = active !== null ? days[active] : null
  const pos = active !== null ? ((active + 0.5) / days.length) * 100 : 0
  const shift = pos < 30 ? '-12px' : pos > 70 ? 'calc(-100% + 12px)' : '-50%'

  return (
    <div>
      <div className="flex gap-2">
        {/* Ось Y: круглые деления, та же сетка, что в поле графика */}
        <div className="relative h-44 w-6 shrink-0 text-right text-[10px] tabular-nums" style={{ color: INK_3 }} aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - (t / top) * 100}%` }}>{t}</span>
          ))}
        </div>
        <div className="relative h-44 min-w-0 flex-1" onMouseLeave={() => setActive(null)}>
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 h-px" style={{ top: `${100 - (t / top) * 100}%`, background: t === 0 ? '#d9d1e6' : LINE }} aria-hidden />
          ))}
          <div className="absolute inset-0 flex items-end" role="list" aria-label="Заказы по дням">
            {days.map((d, i) => (
              <div
                key={d.day}
                role="listitem"
                tabIndex={0}
                aria-label={`${dayLabel(d.day)}: ${num(d.orders)} зак.`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="relative flex h-full min-w-0 flex-1 cursor-default items-end justify-center px-[1px] outline-none"
                style={{ background: active === i ? 'rgba(124,58,237,0.06)' : undefined }}
              >
                {i === peak && active === null && (
                  <span className="absolute left-1/2 -translate-x-1/2 text-[10px] font-semibold tabular-nums" style={{ color: INK_2, bottom: `calc(${(d.orders / top) * 100}% + 3px)` }}>
                    {d.orders}
                  </span>
                )}
                {d.orders > 0 && (
                  <div className="w-full max-w-6 rounded-t-[4px]" style={{ height: `${(d.orders / top) * 100}%`, background: SERIES[0], opacity: active === null || active === i ? 1 : 0.55 }} />
                )}
              </div>
            ))}
          </div>
          {hovered && (
            <div
              className="pointer-events-none absolute -top-2 z-10 w-max max-w-[220px] rounded-xl bg-white px-3 py-2 text-xs"
              style={{ left: `${pos}%`, transform: `translate(${shift}, -100%)`, border: `1px solid ${LINE}`, boxShadow: '0 8px 24px -8px rgba(23,16,42,0.25)' }}
              role="status"
            >
              <div className="font-semibold" style={{ color: INK }}>{dayLong(hovered.day)}</div>
              <div className="mt-1 flex items-center gap-1.5" style={{ color: INK_2 }}>
                <span className="size-2 rounded-full" style={{ background: SERIES[0] }} aria-hidden />
                Заказов: <strong style={{ color: INK }}>{num(hovered.orders)}</strong>
              </div>
              <div className="mt-0.5" style={{ color: INK_3 }}>
                {hovered.revenue ? <>выручка по заказам с суммой: <strong style={{ color: INK }}>{money(hovered.revenue)}</strong></> : 'выручки с суммой нет'}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="ml-8 mt-1.5 flex justify-between text-[11px]" style={{ color: INK_3 }}>
        <span>{dayLabel(days[0].day)}</span>
        {days.length > 2 && <span>{dayLabel(days[Math.floor((days.length - 1) / 2)].day)}</span>}
        {days.length > 1 && <span>{dayLabel(days[days.length - 1].day)}</span>}
      </div>
    </div>
  )
}

export default function PurchaseAnalytics({ period, onStamp }: { period: PeriodInput; onStamp?: (s: Stamp | null) => void }) {
  const { data, error, loading, loadedAt } = useAnalyticsData(getPurchasesAnalytics, period)
  useReportStamp(data?.generatedAt, loadedAt, onStamp)
  const [stock, setStock] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    getWhatsappSettings()
      .then((settings) => setStock(settings?.stock.quantity ?? null))
      .catch((err: unknown) => { if (!recoverFromStaleAction(err)) setStock(null) })
  }, [])

  if (error) return <ErrorState text={error} />
  if (loading || !data) return <TabSkeleton text="Считаем покупки…" tiles={7} blocks={['chart', 'bars']} />
  return <PurchasesView data={data} stock={stock} extra={<ReceiptsCard period={period} />} />
}

/** `stock`: undefined — ещё грузится, null — склад не ведётся. `extra` — карточки со своей загрузкой. */
export function PurchasesView({ data, stock, extra }: {
  data: PurchasesAnalytics
  stock: number | null | undefined
  extra?: React.ReactNode
}) {
  const avg = data.withAmount ? data.revenue / data.withAmount : null

  return (
    <TabBody>
      <Lead>Заказы, созданные в эти дни, кроме отменённых и удалённых. Все каналы.</Lead>

      <KpiGrid>
        <Kpi hero icon={Wallet} label="Выручка" value={money(data.revenue)}
          sub={data.noAmount ? `только заказы с суммой; у ${num(data.noAmount)} из ${num(data.orders)} зак. сумма не указана` : 'сумма всех заказов'} />
        <Kpi icon={ShoppingBag} label="Заказов" value={num(data.orders)} />
        <Kpi icon={Package} label="Коробок" value={num(data.boxes)}
          sub={data.noQuantity ? `сумма количества; у ${num(data.noQuantity)} зак. количество не указано` : 'сумма количества в заказах'} />
        <Kpi icon={Receipt} label="Средний чек" value={avg === null ? '—' : money(avg)}
          sub={avg === null ? 'ни у одного заказа нет суммы' : `по ${num(data.withAmount)} зак. с суммой`} />
        <Kpi icon={Users} label="Покупатели" value={num(data.buyers)}
          sub={`разные номера (последние 9 цифр)${data.noPhone ? `; ${num(data.noPhone)} зак. без номера не учтены` : ''}`} />
        <Kpi icon={Repeat} tone="good" label="Повторные покупатели" value={num(data.repeatBuyers)}
          sub="покупатели периода, у кого по номеру 2+ заказа за всё время" />
        <Kpi
          icon={Warehouse}
          label="Остаток на складе сейчас"
          value={stock === undefined ? '…' : stock === null ? 'не ведётся' : num(stock)}
          tone={stock !== null && stock !== undefined && stock <= 5 ? 'warn' : 'brand'}
          sub="из «Товароучёта», не зависит от периода"
        />
      </KpiGrid>

      <div className="grid items-start gap-4 md:grid-cols-2 md:gap-5">
        <Card icon={BarChart3} title="Заказы по дням" hint="Число заказов за каждый день периода (по Бишкеку). Наведите на столбик — выручка по заказам с суммой.">
          {data.orders === 0
            ? <EmptyState icon={ShoppingBag} text="За период заказов нет" />
            : <DailyChart data={data} />}
        </Card>
        <Card icon={MapPin} title="Города" hint="Город из заказа; если в заказе не указан — «Не указан».">
          {data.cities.length === 0
            ? <EmptyState icon={MapPin} text="За период заказов нет" />
            : <Bars items={data.cities.map((c) => ({ label: c.city, value: c.orders, hint: `${num(c.orders)} зак.` }))} />}
        </Card>
      </div>

      {extra}
    </TabBody>
  )
}
