'use client'

// Города из переписки: первый ответ клиента после вопроса бота о городе,
// распознанный словарём (src/lib/analytics/city.ts). Считает
// analytics_city_answers (058) + loadCities.

import { useState } from 'react'
import { MapPin } from 'lucide-react'
import { getCitiesAnalytics, type BoughtGroup, type CitiesAnalytics } from '@/lib/analytics/client-api'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData } from './useAnalyticsData'
import { BRAND, BRAND_SOFT, Card, EmptyState, Expand, INK, INK_2, INK_3, LINE, Note, SERIES, TRACK, num, pct } from './viz'

const COUNTRY: Record<string, string> = { KG: 'КР', KZ: 'КЗ', UZ: 'УЗ' }
const INITIAL = 12

export default function CitiesCard({ period }: { period: PeriodInput }) {
  const { data, error, loading } = useAnalyticsData(getCitiesAnalytics, period)
  if (error) return <Card icon={MapPin} title="Города из переписки"><Note tone="bad">Не удалось посчитать: {error}</Note></Card>
  if (loading || !data) {
    return (
      <Card icon={MapPin} title="Города из переписки" hint="Считаем…">
        <div className="flex animate-pulse flex-col gap-3" aria-busy>
          {[90, 45, 25, 15].map((w) => <div key={w} className="h-2.5 rounded-full" style={{ width: `${w}%`, background: TRACK }} />)}
        </div>
      </Card>
    )
  }
  return <CitiesView data={data} />
}

function Row({ label, tag, g, top, muted }: { label: string; tag?: string; g: BoughtGroup; top: number; muted?: boolean }) {
  return (
    <div title={`${label}: ${num(g.clients)} клиентов, купили ${num(g.bought)}`}>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-1.5" style={{ color: muted ? INK_2 : INK }}>
          <span className="truncate">{label}</span>
          {tag && <span className="shrink-0 rounded px-1 text-[9px] font-semibold" style={{ background: BRAND_SOFT, color: BRAND }}>{tag}</span>}
        </span>
        <span className="shrink-0 tabular-nums" style={{ color: INK_3 }}>
          <strong style={{ color: INK }}>{num(g.clients)}</strong> · купили {num(g.bought)}
        </span>
      </div>
      <div className="h-2 rounded-full" style={{ background: TRACK }}>
        {g.clients > 0 && (
          <div className="h-full rounded-full" style={{ width: `${Math.max(1.5, (g.clients / top) * 100)}%`, background: muted ? '#b3abc2' : SERIES[0] }} />
        )}
      </div>
    </div>
  )
}

export function CitiesView({ data }: { data: CitiesAnalytics }) {
  const [all, setAll] = useState(false)
  const top = Math.max(1, ...data.cities.map((c) => c.clients), data.unrecognized.clients, data.noAnswer.clients)
  const shown = all ? data.cities : data.cities.slice(0, INITIAL)
  const recognized = data.answered - data.unrecognized.clients

  return (
    <Card icon={MapPin} title="Города из переписки"
      hint="Чаты, где бот спросил город в эти дни. Город — из первого сообщения клиента после вопроса, по словарю городов Кыргызстана, Казахстана и Узбекистана (падежи, латиница, опечатка в одну букву). Купили — заказ с номера после вопроса о городе.">
      {data.asked === 0 ? <EmptyState icon={MapPin} text="Бот не спрашивал город в эти дни" /> : (
        <>
          <p className="mb-3 text-xs" style={{ color: INK_2 }}>
            Спросил — <strong style={{ color: INK }}>{num(data.asked)}</strong>, ответили — {num(data.answered)}, город распознан у{' '}
            {num(recognized)} ({pct(recognized, data.answered)} ответивших).
          </p>
          <div className="flex flex-col gap-2.5">
            {shown.map((c) => <Row key={c.city} label={c.city} tag={COUNTRY[c.country]} g={c} top={top} />)}
          </div>
          {data.cities.length > INITIAL && (
            <button type="button" onClick={() => setAll((v) => !v)}
              className="mt-2 w-full rounded-xl py-2 text-xs font-semibold" style={{ background: BRAND_SOFT, color: BRAND }}>
              {all ? 'Свернуть' : `Показать все ${num(data.cities.length)}`}
            </button>
          )}
          <div className="mt-3 flex flex-col gap-2.5 pt-3" style={{ borderTop: `1px solid ${LINE}` }}>
            <Row label="Не распознано" g={data.unrecognized} top={top} muted />
            <Row label="Не ответили после вопроса" g={data.noAnswer} top={top} muted />
          </div>
          {data.unrecognized.examples.length > 0 && (
            <div className="mt-3">
              <Expand summary={<span>Что писали те, у кого город не распознан</span>}>
                <ul className="text-xs">
                  {data.unrecognized.examples.map((e) => (
                    <li key={e.text} className="flex justify-between gap-3 py-1" style={{ borderTop: `1px solid ${LINE}` }}>
                      <span className="min-w-0 break-words" style={{ color: INK }}>
                        {e.text.startsWith('[media]') ? 'вложение (фото/файл)' : e.text}
                      </span>
                      <span className="shrink-0 tabular-nums" style={{ color: INK_3 }}>{num(e.clients)}</span>
                    </li>
                  ))}
                </ul>
              </Expand>
            </div>
          )}
        </>
      )}
    </Card>
  )
}
