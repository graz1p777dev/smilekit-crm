'use client'

// Вкладка «Покупки»: заказы за период из таблицы orders. Где в заказе нет
// суммы или количества — так и пишем, ничего не досчитываем.

import { useEffect, useState } from 'react'
import { getPurchasesAnalytics, type PurchasesAnalytics } from '@/lib/analytics/client-api'
import { getWhatsappSettings } from '@/actions/whatsapp-settings'
import { daysOf, type PeriodInput } from '@/lib/analytics/period'
import { recoverFromStaleAction } from '@/lib/stale-action'
import { useAnalyticsData } from './useAnalyticsData'
import { Skeleton } from './ConversionAnalytics'
import { Bars, Card, INK_3, SERIES, Stat, money, num } from './viz'

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'short' })

function DailyChart({ data }: { data: PurchasesAnalytics }) {
  const byDay = new Map(data.daily.map((d) => [d.day, d]))
  const days = daysOf(data.range).map((day) => byDay.get(day) ?? { day, orders: 0, revenue: 0 })
  const max = Math.max(1, ...days.map((d) => d.orders))
  return (
    <div>
      <div className="flex h-28 items-end gap-[2px]" role="img" aria-label="Заказы по дням">
        {days.map((d) => (
          <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col justify-end"
            title={`${dayLabel(d.day)}: ${num(d.orders)} зак.${d.revenue ? `, выручка по заказам с суммой ${money(d.revenue)}` : ''}`}>
            {d.orders > 0 && (
              <span className="mb-0.5 text-center text-[10px] tabular-nums" style={{ color: INK_3 }}>{d.orders}</span>
            )}
            <div className="rounded-t" style={{ height: `${(d.orders / max) * 80}%`, minHeight: d.orders ? 3 : 1, background: d.orders ? SERIES[0] : '#ece5e5' }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px]" style={{ color: INK_3 }}>
        <span>{dayLabel(days[0].day)}</span>
        {days.length > 1 && <span>{dayLabel(days[days.length - 1].day)}</span>}
      </div>
    </div>
  )
}

export default function PurchaseAnalytics({ period }: { period: PeriodInput }) {
  const { data, error, loading } = useAnalyticsData(getPurchasesAnalytics, period)
  const [stock, setStock] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    getWhatsappSettings()
      .then((settings) => setStock(settings?.stock.quantity ?? null))
      .catch((err: unknown) => { if (!recoverFromStaleAction(err)) setStock(null) })
  }, [])

  if (error) return <p className="p-8 text-sm" style={{ color: '#b91c1c' }}>{error}</p>
  if (loading || !data) return <Skeleton text="Считаем покупки…" />

  const avg = data.withAmount ? data.revenue / data.withAmount : null

  return (
    <div className="flex flex-col gap-5 p-4 md:p-8">
      <p className="text-xs" style={{ color: INK_3 }}>
        Заказы, созданные в эти дни, кроме отменённых и удалённых. Все каналы.
      </p>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Stat label="Заказов" value={num(data.orders)} />
        <Stat label="Коробок" value={num(data.boxes)}
          sub={data.noQuantity ? `сумма количества; у ${num(data.noQuantity)} зак. количество не указано` : 'сумма количества в заказах'} />
        <Stat label="Выручка" value={money(data.revenue)} tone="good"
          sub={data.noAmount ? `только заказы с суммой; у ${num(data.noAmount)} из ${num(data.orders)} зак. сумма не указана` : 'сумма всех заказов'} />
        <Stat label="Средний чек" value={avg === null ? '—' : money(avg)}
          sub={avg === null ? 'ни у одного заказа нет суммы' : `по ${num(data.withAmount)} зак. с суммой`} />
        <Stat label="Покупатели" value={num(data.buyers)}
          sub={`разные номера (последние 9 цифр)${data.noPhone ? `; ${num(data.noPhone)} зак. без номера не учтены` : ''}`} />
        <Stat label="Повторные покупатели" value={num(data.repeatBuyers)}
          sub="покупатели периода, у кого по номеру 2+ заказа за всё время" />
        <Stat
          label="Остаток на складе сейчас"
          value={stock === undefined ? '…' : stock === null ? 'не ведётся' : num(stock)}
          tone={stock !== null && stock !== undefined && stock <= 5 ? 'warn' : 'brand'}
          sub="из «Товароучёта», не зависит от периода"
        />
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <Card title="Заказы по дням" hint="Число заказов за каждый день периода (по Бишкеку). Наведите на столбик — выручка по заказам с суммой.">
          <DailyChart data={data} />
        </Card>
        <Card title="Города" hint="Город из заказа; если в заказе не указан — «Не указан».">
          <Bars items={data.cities.map((c) => ({ label: c.city, value: c.orders, hint: `${num(c.orders)} зак.` }))} />
        </Card>
      </div>
    </div>
  )
}
