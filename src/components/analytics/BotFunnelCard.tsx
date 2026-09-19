'use client'

// Воронка бота по новым лидам с потерями на каждом шаге. Шаг засчитан, только
// если пройдены все предыдущие (строгая воронка). Считает
// analytics_bot_lead_funnel (054) + src/lib/analytics/bot-funnel.ts.

import { Filter, HelpCircle } from 'lucide-react'
import { getBotFunnelAnalytics, type BotFunnelAnalytics } from '@/lib/analytics/client-api'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData } from './useAnalyticsData'
import {
  BRAND, BRAND_SOFT, Card, EmptyState, Expand, INK, INK_2, INK_3, Note, SERIES, TRACK, num, pct,
} from './viz'

export default function BotFunnelCard({ period }: { period: PeriodInput }) {
  const { data, error, loading } = useAnalyticsData(getBotFunnelAnalytics, period)
  if (error) return <Card icon={Filter} title="Воронка бота"><Note tone="bad">Не удалось посчитать: {error}</Note></Card>
  if (loading || !data) {
    return (
      <Card icon={Filter} title="Воронка бота" hint="Считаем…">
        <div className="flex animate-pulse flex-col gap-3" aria-busy>
          {[100, 90, 70, 55, 45, 30, 20, 12, 6].map((w) => (
            <div key={w} className="h-3 rounded-full" style={{ width: `${w}%`, background: TRACK }} />
          ))}
        </div>
      </Card>
    )
  }
  return <BotFunnelView data={data} />
}

export function BotFunnelView({ data }: { data: BotFunnelAnalytics }) {
  const top = data.leads
  const worst = data.steps.reduce<number | null>((best, s, i) =>
    s.lossFromPrev !== null && s.lossFromPrev > 0 && (best === null || s.lossFromPrev > (data.steps[best].lossFromPrev ?? 0)) ? i : best, null)

  return (
    <Card icon={Filter} title="Воронка бота" wide
      hint="Новые лиды периода: самое первое сообщение клиента — в эти дни. Шаг засчитан, только если пройдены все предыдущие; факты — до сейчас. Потеря — сколько не дошли от прошлого шага.">
      {top === 0 ? <EmptyState icon={Filter} text="Новых лидов за период нет" /> : (
        <ol className="flex flex-col gap-3">
          {data.steps.map((s, i) => (
            <li key={s.bit} title={`${s.label}: ${num(s.reached)} (${pct(s.reached, top)} от новых). ${s.rule} Без учёта порядка шагов этот факт есть у ${num(s.anyOrder)}.`}>
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
                <span className="flex min-w-0 items-center gap-2" style={{ color: INK }}>
                  <span className="grid size-5 shrink-0 place-items-center rounded-md text-[10px] font-bold" style={{ background: BRAND_SOFT, color: BRAND }}>
                    {i + 1}
                  </span>
                  <span className="font-medium">{s.label}</span>
                  {i === worst && (
                    <span className="rounded-full px-1.5 py-px text-[10px] font-semibold" style={{ background: '#fdf0e6', color: '#c2410c' }}>
                      больше всего потерь
                    </span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums" style={{ color: INK_3 }}>
                  <strong style={{ color: INK }}>{num(s.reached)}</strong> · {pct(s.reached, top)}
                  {s.lossFromPrev !== null && (
                    <> · <span style={{ color: s.lossFromPrev > 0 ? INK_2 : INK_3 }}>
                      потеря {(s.lossFromPrev * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%
                    </span></>
                  )}
                </span>
              </div>
              <div className="h-3 rounded-full" style={{ background: TRACK }}>
                {s.reached > 0 && (
                  <div className="h-full rounded-full" style={{ width: `${Math.max(1, (s.reached / top) * 100)}%`, background: SERIES[0] }} />
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {top > 0 && (
        <Note>
          Всего купили из новых лидов: <strong style={{ color: INK }}>{num(data.boughtTotal)}</strong> ({pct(data.boughtTotal, top)}),
          из них без передачи менеджеру — {num(data.boughtWithoutHandoff)}: в последний шаг строгой воронки они не попадают.
        </Note>
      )}
      <div className="mt-3">
        <Expand summary={<span className="flex items-center gap-1.5"><HelpCircle className="size-3.5" aria-hidden />Правило каждого шага</span>}>
          <ol className="list-decimal pl-4 text-[11px] leading-relaxed" style={{ color: INK_3 }}>
            {data.steps.map((s) => (
              <li key={s.bit}><strong style={{ color: INK_2 }}>{s.label}</strong> — {s.rule} Без учёта порядка: {num(s.anyOrder)}.</li>
            ))}
          </ol>
        </Expand>
      </div>
    </Card>
  )
}
