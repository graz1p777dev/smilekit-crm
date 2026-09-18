'use client'

// Вкладка «Сотрудники»: всё считается по сменам (staff_shifts). Ответы с
// телефона подписаны одним «Smilekit», поэтому человека определяет только
// то, кто был на смене в этот момент.

import { getStaffAnalytics, type ChatRef, type StaffWork } from '@/lib/analytics/client-api'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData } from './useAnalyticsData'
import { Skeleton } from './ConversionAnalytics'
import { Card, ClientCell, Expand, INK, INK_2, INK_3, LINE, ScrollTable, Stat, money, num, pct, phoneLabel } from './viz'

const hours = (ms: number) => {
  const totalMinutes = Math.floor(ms / 60_000)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return h ? `${h} ч ${m} мин` : `${m} мин`
}

function Unanswered({ rows, total }: { rows: ChatRef[]; total: number }) {
  if (total === 0) return null
  return (
    <Expand summary={<span>Не ответил — {num(total)} (список)</span>}>
      {total > rows.length && (
        <p className="mb-1 text-[11px]" style={{ color: INK_3 }}>Показаны {num(rows.length)} из {num(total)}.</p>
      )}
      <ScrollTable head={['Клиент', 'Телефон']}>
        {rows.map((r) => (
          <tr key={r.chatId} style={{ borderTop: `1px solid ${LINE}` }}>
            <td className="py-1.5 pr-3"><ClientCell name={r.name} dealId={r.dealId} /></td>
            <td className="py-1.5 pr-3 tabular-nums" style={{ color: INK_2 }}>{phoneLabel(r.chatId)}</td>
          </tr>
        ))}
      </ScrollTable>
    </Expand>
  )
}

function WorkStats({ work, unansweredTotal }: { work: StaffWork; unansweredTotal: number }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Stat label="Лиды" value={num(work.leads)} sub="чаты, где клиент писал в это время" />
        <Stat label="Ответил" value={num(work.answered)} tone="good"
          sub="сообщение человека в чате после сообщения клиента, в то же время" />
        <Stat label="Не ответил" value={num(unansweredTotal)} tone="warn" sub="остальные лиды" />
        <Stat label="Продажи" value={num(work.orders)}
          sub={`заказы, созданные в это время; выручка ${money(work.revenue)}${work.ordersNoAmount ? `, у ${num(work.ordersNoAmount)} зак. сумма не указана` : ''}`} />
        <Stat label="Купили из обслуженных" value={num(work.boughtAfterAnswer)}
          sub={`чаты с ответом, где потом был заказ · ${pct(work.boughtAfterAnswer, work.answered)} от ответивших`} />
      </div>
      <Unanswered rows={work.unanswered} total={unansweredTotal} />
    </div>
  )
}

export default function StaffAnalytics({ period }: { period: PeriodInput }) {
  const { data, error, loading } = useAnalyticsData(getStaffAnalytics, period)
  if (error) return <p className="p-8 text-sm" style={{ color: '#b91c1c' }}>{error}</p>
  if (loading || !data) return <Skeleton text="Считаем смены…" />

  return (
    <div className="flex flex-col gap-5 p-4 md:p-8">
      <p className="text-xs" style={{ color: INK_3 }}>
        Всё, что было во время смены, засчитывается тем, кто был на смене. «Работа вместе» — засчитывается обоим.
        Смены обрезаются границами периода; открытая смена считается до текущего момента.
      </p>

      {data.staff.length === 0 ? (
        <Card title="Сотрудники">
          <p className="text-sm" style={{ color: INK_3 }}>Смен за период не было.</p>
        </Card>
      ) : (
        data.staff.map((s) => (
          <Card key={s.hours.staffId} title={s.hours.name}
            hint={`На смене ${hours(s.hours.totalMs)}${s.hours.togetherMs ? `, из них вместе ${hours(s.hours.togetherMs)}: ${s.hours.withWhom.map((w) => `с ${w.name} — ${hours(w.ms)}`).join(', ')}` : ', один'}`}>
            <WorkStats work={s} unansweredTotal={s.leads - s.answered} />
          </Card>
        ))
      )}

      <Card title="Вне смен" hint="Время, когда на смене не было никого: сообщения клиентов, ответы людей и заказы в эти моменты.">
        <WorkStats work={data.offShift} unansweredTotal={data.offShift.unansweredTotal} />
        {data.staff.length === 0 && (
          <p className="mt-2 text-[11px]" style={{ color: INK }}>Смен не было — поэтому сюда попадает весь период.</p>
        )}
      </Card>
    </div>
  )
}
