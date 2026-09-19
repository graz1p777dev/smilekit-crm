'use client'

// Новые лиды: пришли по рекламе (кодовое слово «Улыбка» из автоприветствия
// Meta) или остальные. Считает analytics_ad_source (057).

import { Megaphone } from 'lucide-react'
import { getAdSourceAnalytics, type AdSourceAnalytics } from '@/lib/analytics/client-api'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData } from './useAnalyticsData'
import { Card, INK, INK_2, INK_3, LINE, Note, SERIES, SegmentBar, TRACK, num, pct } from './viz'

export default function AdSourceCard({ period }: { period: PeriodInput }) {
  const { data, error, loading } = useAnalyticsData(getAdSourceAnalytics, period)
  if (error) return <Card icon={Megaphone} title="Реклама или остальные"><Note tone="bad">Не удалось посчитать: {error}</Note></Card>
  if (loading || !data) {
    return (
      <Card icon={Megaphone} title="Реклама или остальные" hint="Считаем…">
        <div className="h-3.5 animate-pulse rounded-full" style={{ background: TRACK }} aria-busy />
      </Card>
    )
  }
  return <AdSourceView data={data} />
}

export function AdSourceView({ data }: { data: AdSourceAnalytics }) {
  const total = data.ad.clients + data.other.clients
  return (
    <Card icon={Megaphone} title="Реклама или остальные"
      hint="Новые лиды периода. Реклама — первое сообщение клиента начинается со слова «Улыбка» (его просит написать автоприветствие рекламы Meta) или это стандартный текст кнопки Meta «Можно узнать об этом подробнее?».">
      <SegmentBar total={total} columns={2} segments={[
        { label: 'По рекламе (кодовое слово)', value: data.ad.clients, color: SERIES[0],
          note: `купили ${num(data.ad.bought)} · ${pct(data.ad.bought, data.ad.clients)}` },
        { label: 'Остальные', value: data.other.clients, color: SERIES[1],
          note: `купили ${num(data.other.bought)} · ${pct(data.other.bought, data.other.clients)}` },
      ]} />
      <Note>
        «Остальные» — органика <strong style={{ color: INK_2 }}>или</strong> реклама, где клиент не написал кодовое слово: по базе их
        не различить (само автоприветствие Meta в переписку не сохраняется). Купил — заказ с номера после первого сообщения.
      </Note>
      {data.otherTop.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] font-semibold" style={{ color: INK_2 }}>Частые первые сообщения «остальных»</p>
          <ul className="text-xs">
            {data.otherTop.map((t) => (
              <li key={t.text} className="flex justify-between gap-3 py-1" style={{ borderTop: `1px solid ${LINE}` }}>
                <span className="min-w-0 break-words" style={{ color: INK }}>
                  {t.text.startsWith('[media]') ? 'вложение (фото/файл)' : t.text === '{{swe001}}' ? '{{SWE001}} — так записано в базе, текста сообщения нет' : t.text || '(пусто)'}
                </span>
                <span className="shrink-0 tabular-nums" style={{ color: INK_3 }}>{num(t.clients)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}
