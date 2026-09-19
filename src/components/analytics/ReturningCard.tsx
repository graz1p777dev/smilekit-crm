'use client'

// Вернувшиеся клиенты: молчали ≥ 3 суток и снова написали в периоде —
// после рассылки или сами. Считает analytics_returning (059).

import { Undo2 } from 'lucide-react'
import { getReturningAnalytics, type ReturningAnalytics } from '@/lib/analytics/client-api'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData } from './useAnalyticsData'
import { Card, EmptyState, INK, INK_2, Note, SERIES, SegmentBar, TRACK, num, pct } from './viz'

export default function ReturningCard({ period }: { period: PeriodInput }) {
  const { data, error, loading } = useAnalyticsData(getReturningAnalytics, period)
  if (error) return <Card icon={Undo2} title="Вернувшиеся клиенты"><Note tone="bad">Не удалось посчитать: {error}</Note></Card>
  if (loading || !data) {
    return (
      <Card icon={Undo2} title="Вернувшиеся клиенты" hint="Считаем…">
        <div className="h-3.5 animate-pulse rounded-full" style={{ background: TRACK }} aria-busy />
      </Card>
    )
  }
  return <ReturningView data={data} />
}

export function ReturningView({ data }: { data: ReturningAnalytics }) {
  const bought = data.afterCampaign.bought + data.self.bought
  return (
    <Card icon={Undo2} title="Вернувшиеся клиенты"
      hint="Клиент написал в эти дни, а до этого молчал не меньше 3 суток (его предыдущее сообщение — раньше чем за 72 часа; наши сообщения молчание не прерывают). Считается один раз — по первому возвращению в периоде.">
      {data.returned === 0 ? <EmptyState icon={Undo2} text="Никто не вернулся после паузы в 3 суток" /> : (
        <>
          <p className="mb-3 text-xs" style={{ color: INK_2 }}>
            Вернулись <strong style={{ color: INK }}>{num(data.returned)}</strong> из {num(data.wrote)} писавших за период,
            купили {num(bought)} ({pct(bought, data.returned)}).
          </p>
          <SegmentBar total={data.returned} columns={2} segments={[
            { label: 'После рассылки', value: data.afterCampaign.clients, color: SERIES[0],
              note: `купили ${num(data.afterCampaign.bought)} · ${pct(data.afterCampaign.bought, data.afterCampaign.clients)}` },
            { label: 'Сами', value: data.self.clients, color: SERIES[1],
              note: `купили ${num(data.self.bought)} · ${pct(data.self.bought, data.self.clients)}` },
          ]} />
        </>
      )}
      <Note>
        После рассылки — за 24 часа до возвращения этому клиенту ушла рассылка. Купил — заказ с номера после возвращения.
      </Note>
    </Card>
  )
}
