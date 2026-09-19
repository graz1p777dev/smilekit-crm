'use client'

// Скидки бота: кому назвал 13% и 20% и сколько потом купили — против новых
// лидов без скидки. Считает analytics_discounts (056).

import { Percent } from 'lucide-react'
import { getDiscountAnalytics, type DiscountAnalytics } from '@/lib/analytics/client-api'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData } from './useAnalyticsData'
import { Card, INK, INK_3, Note, SERIES, TRACK, num, pct } from './viz'

export default function DiscountCard({ period }: { period: PeriodInput }) {
  const { data, error, loading } = useAnalyticsData(getDiscountAnalytics, period)
  if (error) return <Card icon={Percent} title="Скидки и покупки"><Note tone="bad">Не удалось посчитать: {error}</Note></Card>
  if (loading || !data) {
    return (
      <Card icon={Percent} title="Скидки и покупки" hint="Считаем…">
        <div className="flex animate-pulse flex-col gap-3" aria-busy>
          {[70, 50, 90].map((w) => <div key={w} className="h-3 rounded-full" style={{ width: `${w}%`, background: TRACK }} />)}
        </div>
      </Card>
    )
  }
  return <DiscountView data={data} />
}

export function DiscountView({ data }: { data: DiscountAnalytics }) {
  const rows = [
    { label: 'Бот назвал скидку 13%', g: data.d13, rule: 'метка discount13 в эти дни; купил — заказ после метки' },
    { label: 'Бот назвал скидку 20%', g: data.d20, rule: 'метка discount20 в эти дни; купил — заказ после метки' },
    { label: 'Новые лиды без скидки', g: data.newNoDiscount, rule: 'первое сообщение в эти дни, скидку не называли ни разу; купил — заказ после первого сообщения' },
  ]
  const top = Math.max(...rows.map((r) => (r.g.clients ? r.g.bought / r.g.clients : 0)), 0.0001)
  return (
    <Card icon={Percent} title="Скидки и покупки"
      hint="Скидка — служебная метка бота (он назвал клиенту цену со скидкой этой ступени). Купил — заказ (не отменён) с номера клиента, в любой момент до сейчас. Полоса — доля купивших, для сравнения групп.">
      <div className="flex flex-col gap-3.5">
        {rows.map((r) => {
          const rate = r.g.clients ? r.g.bought / r.g.clients : 0
          return (
            <div key={r.label} title={`${r.label}: купили ${num(r.g.bought)} из ${num(r.g.clients)}. Правило: ${r.rule}.`}>
              <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                <span className="min-w-0" style={{ color: INK }}>
                  {r.label}
                  <span className="block text-[11px]" style={{ color: INK_3 }}>{r.rule}</span>
                </span>
                <span className="shrink-0 tabular-nums" style={{ color: INK_3 }}>
                  {num(r.g.bought)} из {num(r.g.clients)} · <strong style={{ color: INK }}>{pct(r.g.bought, r.g.clients)}</strong>
                </span>
              </div>
              <div className="h-2 rounded-full" style={{ background: TRACK }}>
                {rate > 0 && <div className="h-full rounded-full" style={{ width: `${Math.max(1.5, (rate / top) * 100)}%`, background: SERIES[0] }} />}
              </div>
            </div>
          )
        })}
      </div>
      <Note>
        Среди тех же новых лидов периода скидку назвали {num(data.newDiscount.clients)},
        купили {num(data.newDiscount.bought)} ({pct(data.newDiscount.bought, data.newDiscount.clients)}; заказ после первой метки скидки).
        Скидку называют в ответ на «дорого» — это уже сомневающиеся клиенты, поэтому разница не равна «эффекту скидки».
      </Note>
    </Card>
  )
}
