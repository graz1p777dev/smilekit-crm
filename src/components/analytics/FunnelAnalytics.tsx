'use client'

// Вкладка «Воронка сделок»: сделки, созданные в периоде, — до какого этапа
// дошли (история переходов deal_events + текущий этап), откуда пришли.

import { Archive, Filter, Inbox, Layers, MapPin, Share2, Trophy } from 'lucide-react'
import { getFunnelAnalytics, type FunnelAnalytics as FunnelData } from '@/lib/analytics/client-api'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData, useReportStamp, type Stamp } from './useAnalyticsData'
import CitiesCard from './CitiesCard'
import {
  BRAND, BRAND_SOFT, Bars, Card, EmptyState, ErrorState, INK, INK_2, INK_3, Kpi, KpiGrid, Lead, Note, SERIES, TRACK,
  TabBody, TabSkeleton, num, pct,
} from './viz'

const SOURCE_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp', amocrm: 'WhatsApp (старые, amoCRM)', telegram: 'Telegram',
  instagram: 'Instagram', site: 'Витрина', manual: 'Вручную', '': 'Не указан',
}

export default function FunnelAnalytics({ period, onStamp }: { period: PeriodInput; onStamp?: (s: Stamp | null) => void }) {
  const { data, error, loading, loadedAt } = useAnalyticsData(getFunnelAnalytics, period)
  useReportStamp(null, loadedAt, onStamp)
  if (error) return <ErrorState text={error} />
  if (loading || !data) return <TabSkeleton text="Считаем воронку…" blocks={['bars', 'bars']} />
  // Город в карточке сделки почти никогда не заполнен — показываем города,
  // которые клиенты назвали боту в переписке (та же карточка, что на «Лидах»).
  return <FunnelView data={data} cities={<CitiesCard period={period} />} />
}

/**
 * Этапы — полосы в порядке воронки; длина — «дошла» от всех сделок периода.
 * Номер — место этапа в воронке, поэтому у скрытых пустых этапов остаётся пропуск.
 */
function StageBars({ stages, deals }: { stages: FunnelData['stages']; deals: number }) {
  const active = stages.filter((s) => s.reached > 0 || s.now > 0)
  const empty = stages.filter((s) => s.reached === 0 && s.now === 0)
  if (active.length === 0) return <EmptyState icon={Filter} text="Сделок за период нет" />
  return (
    <div>
      <ol className="flex flex-col gap-3.5">
        {active.map((s) => {
          const share = deals ? s.reached / deals : 0
          const tag = s.kind === 'won' ? 'успех' : s.kind === 'lost' ? 'закрыта' : s.isDefault ? 'первый этап' : null
          return (
            <li key={s.name} title={`${s.name}: дошла ${num(s.reached)} (${pct(s.reached, deals)}), сейчас ${num(s.now)}`}>
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
                <span className="flex min-w-0 items-center gap-2" style={{ color: INK }}>
                  <span className="grid size-5 shrink-0 place-items-center rounded-md text-[10px] font-bold" style={{ background: BRAND_SOFT, color: BRAND }}>
                    {stages.indexOf(s) + 1}
                  </span>
                  <span className="font-medium">{s.name}</span>
                  {tag && <span className="rounded-full px-1.5 py-px text-[10px]" style={{ background: '#f4f1f8', color: INK_2 }}>{tag}</span>}
                </span>
                <span className="shrink-0 tabular-nums" style={{ color: INK_3 }}>
                  <strong style={{ color: INK }}>{num(s.reached)}</strong> · {pct(s.reached, deals)} · сейчас {num(s.now)}
                </span>
              </div>
              <div className="h-3 rounded-full" style={{ background: TRACK }}>
                {share > 0 && (
                  <div className="h-full rounded-full" style={{ width: `${Math.max(1, share * 100)}%`, background: SERIES[0] }} />
                )}
              </div>
            </li>
          )
        })}
      </ol>
      {empty.length > 0 && (
        <Note>Ни одна сделка периода не была на этапах: {empty.map((s) => `«${s.name}»`).join(', ')}.</Note>
      )}
    </div>
  )
}

export function FunnelView({ data, cities }: { data: FunnelData; cities?: React.ReactNode }) {
  const won = data.stages.filter((s) => s.kind === 'won').reduce((sum, s) => sum + s.now, 0)
  const lost = data.stages.filter((s) => s.kind === 'lost').reduce((sum, s) => sum + s.now, 0)
  const unsorted = data.stages.filter((s) => s.isDefault).reduce((sum, s) => sum + s.now, 0)
  const knownCities = data.cities.filter((c) => c.city !== 'Не указан')

  return (
    <TabBody>
      <Lead>
        Сделки, созданные в эти дни (бот заводит сделку на первое сообщение клиента). «Дошла» — сделка сейчас на этом
        этапе или когда-то была на него переведена.
      </Lead>

      <KpiGrid>
        <Kpi hero icon={Layers} label="Сделок" value={num(data.deals)} sub="созданы в эти дни" />
        <Kpi icon={Trophy} tone="good" label="Успешно реализовано" value={num(won)} sub={`сейчас на этапе «успех» · ${pct(won, data.deals)}`} />
        <Kpi icon={Archive} label="Закрыто, не реализовано" value={num(lost)} sub={pct(lost, data.deals)} />
        <Kpi icon={Inbox} tone={unsorted ? 'warn' : 'brand'} label="Висят в «Неразобранном»" value={num(unsorted)} sub="сейчас на первом этапе" />
      </KpiGrid>

      <Card icon={Filter} title="Этапы" hint="Дошла — сколько сделок периода побывали на этапе (полоса — доля от всех сделок). Сейчас — сколько стоят на нём прямо сейчас.">
        <StageBars stages={data.stages} deals={data.deals} />
      </Card>

      <div className="grid items-start gap-4 md:grid-cols-2 md:gap-5">
        <Card icon={Share2} title="Откуда пришли" hint="Канал, в котором заведена сделка.">
          <Bars items={data.sources.map((s) => ({ label: SOURCE_LABEL[s.source] ?? s.source, value: s.deals }))} />
        </Card>
        {cities ?? (
          <Card icon={MapPin} title="Города" hint="Город из карточки сделки (до 20 самых частых).">
            {knownCities.length === 0
              ? <EmptyState icon={MapPin} text="В сделках этого периода город не заполнен." />
              : <Bars items={data.cities.map((c) => ({ label: c.city, value: c.deals }))} />}
          </Card>
        )}
      </div>
    </TabBody>
  )
}
