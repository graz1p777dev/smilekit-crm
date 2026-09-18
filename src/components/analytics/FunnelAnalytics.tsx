'use client'

// Вкладка «Воронка сделок»: сделки, созданные в периоде, — до какого этапа
// дошли (история переходов deal_events + текущий этап), откуда пришли.

import { getFunnelAnalytics } from '@/lib/analytics/client-api'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData } from './useAnalyticsData'
import { Skeleton } from './ConversionAnalytics'
import { Bars, Card, INK_3, LINE, ScrollTable, Stat, num, pct } from './viz'

const SOURCE_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp', amocrm: 'WhatsApp (старые, amoCRM)', telegram: 'Telegram',
  instagram: 'Instagram', site: 'Витрина', manual: 'Вручную', '': 'Не указан',
}

export default function FunnelAnalytics({ period }: { period: PeriodInput }) {
  const { data, error, loading } = useAnalyticsData(getFunnelAnalytics, period)
  if (error) return <p className="p-8 text-sm" style={{ color: '#b91c1c' }}>{error}</p>
  if (loading || !data) return <Skeleton text="Считаем воронку…" />

  const won = data.stages.filter((s) => s.kind === 'won').reduce((sum, s) => sum + s.now, 0)
  const lost = data.stages.filter((s) => s.kind === 'lost').reduce((sum, s) => sum + s.now, 0)
  const unsorted = data.stages.filter((s) => s.isDefault).reduce((sum, s) => sum + s.now, 0)
  const knownCities = data.cities.filter((c) => c.city !== 'Не указан')

  return (
    <div className="flex flex-col gap-5 p-4 md:p-8">
      <p className="text-xs" style={{ color: INK_3 }}>
        Сделки, созданные в эти дни (бот заводит сделку на первое сообщение клиента). «Дошла» — сделка сейчас на этом
        этапе или когда-то была на него переведена.
      </p>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Stat label="Сделок" value={num(data.deals)} />
        <Stat label="Успешно реализовано" value={num(won)} tone="good" sub={`сейчас на этапе «успех» · ${pct(won, data.deals)}`} />
        <Stat label="Закрыто, не реализовано" value={num(lost)} sub={pct(lost, data.deals)} />
        <Stat label="Висят в «Неразобранном»" value={num(unsorted)} tone={unsorted ? 'warn' : 'brand'} sub="сейчас на первом этапе" />
      </div>

      <Card title="Этапы" hint="Дошла — сколько сделок периода побывали на этапе. Сейчас — сколько стоят на нём прямо сейчас.">
        <ScrollTable head={['Этап', 'Дошла', 'Доля', 'Сейчас']}>
          {data.stages.map((s) => (
            <tr key={s.name} style={{ borderTop: `1px solid ${LINE}` }}>
              <td className="py-1.5 pr-3">{s.name}</td>
              <td className="py-1.5 pr-3 tabular-nums">{num(s.reached)}</td>
              <td className="py-1.5 pr-3 tabular-nums">{pct(s.reached, data.deals)}</td>
              <td className="py-1.5 pr-3 tabular-nums">{num(s.now)}</td>
            </tr>
          ))}
        </ScrollTable>
      </Card>

      <div className="grid gap-5 md:grid-cols-2">
        <Card title="Откуда пришли" hint="Канал, в котором заведена сделка.">
          <Bars items={data.sources.map((s) => ({ label: SOURCE_LABEL[s.source] ?? s.source, value: s.deals }))} />
        </Card>
        <Card title="Города" hint="Город из карточки сделки (до 20 самых частых).">
          {knownCities.length === 0
            ? <p className="text-sm" style={{ color: INK_3 }}>В сделках этого периода город не заполнен.</p>
            : <Bars items={data.cities.map((c) => ({ label: c.city, value: c.deals }))} />}
        </Card>
      </div>
    </div>
  )
}
