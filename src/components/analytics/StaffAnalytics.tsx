'use client'

// Вкладка «Сотрудники»: всё считается по сменам (staff_shifts). Ответы с
// телефона подписаны одним «Smilekit», поэтому человека определяет только
// то, кто был на смене в этот момент.

import { CalendarX, Moon } from 'lucide-react'
import {
  getStaffAnalytics, getStaffSpeedAnalytics, type ChatRef, type StaffAnalytics as StaffData, type StaffSpeedRow, type StaffWork,
} from '@/lib/analytics/client-api'
import { minutesLabel } from './LoadAnalytics'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData, useReportStamp, type Stamp } from './useAnalyticsData'
import {
  Avatar, BRAND, Card, EmptyState, ErrorState, Expand, INK, INK_3, LINE, Lead, MiniStat, Note, PersonRow, SERIES,
  Split, TabBody, TabSkeleton, money, num, pct,
} from './viz'

const hours = (ms: number) => {
  const totalMinutes = Math.floor(ms / 60_000)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return h ? `${h} ч ${m} мин` : `${m} мин`
}

function Unanswered({ rows, total }: { rows: ChatRef[]; total: number }) {
  if (total === 0) return null
  return (
    <Expand summary={<span>Не ответил — <strong style={{ color: INK }}>{num(total)}</strong> (список)</span>}>
      {total > rows.length && (
        <p className="mb-1 text-[11px]" style={{ color: INK_3 }}>Показаны {num(rows.length)} из {num(total)}.</p>
      )}
      <ul>
        {rows.map((r) => <PersonRow key={r.chatId} name={r.name} dealId={r.dealId} chatId={r.chatId} />)}
      </ul>
    </Expand>
  )
}

function WorkStats({ work, unansweredTotal }: { work: StaffWork; unansweredTotal: number }) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs" style={{ color: INK }}>
          <span className="font-semibold">Лиды — {num(work.leads)}</span>
          <span style={{ color: INK_3 }}>чаты, где клиент писал в это время</span>
        </div>
        <Split
          left={{ label: 'Ответил', value: work.answered, color: SERIES[1] }}
          right={{ label: 'Не ответил', value: unansweredTotal, color: '#ddd6ea' }}
        />
        <p className="mt-1 text-[11px]" style={{ color: INK_3 }}>
          Ответил — сообщение человека в чате после сообщения клиента, в то же время. Не ответил — остальные лиды.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <MiniStat label="Продажи" value={num(work.orders)}
          sub={`заказы, созданные в это время; выручка ${money(work.revenue)}${work.ordersNoAmount ? `, у ${num(work.ordersNoAmount)} зак. сумма не указана` : ''}`} />
        <MiniStat label="Купили из обслуженных" value={num(work.boughtAfterAnswer)}
          sub={`чаты с ответом, где потом был заказ · ${pct(work.boughtAfterAnswer, work.answered)} от ответивших`} />
      </div>
      <Unanswered rows={work.unanswered} total={unansweredTotal} />
    </div>
  )
}

export default function StaffAnalytics({ period, onStamp }: { period: PeriodInput; onStamp?: (s: Stamp | null) => void }) {
  const { data, error, loading, loadedAt } = useAnalyticsData(getStaffAnalytics, period)
  const speed = useAnalyticsData(getStaffSpeedAnalytics, period)
  useReportStamp(data?.generatedAt, loadedAt, onStamp)
  if (error) return <ErrorState text={error} />
  if (loading || !data) return <TabSkeleton text="Считаем смены…" tiles={0} blocks={['bars', 'bars']} />
  return <StaffView data={data} speed={speed.error ? { error: speed.error } : speed.data?.staff ?? null} />
}

/** Скорость и ожидание в смену: медиана ответа, клиентов в час, ждали > 15 мин (061). */
function SpeedStats({ row, leads, hoursMs }: { row: StaffSpeedRow | undefined; leads: number; hoursMs: number }) {
  const perHour = hoursMs > 0 ? leads / (hoursMs / 3_600_000) : null
  return (
    <div className="mb-3 grid grid-cols-3 gap-2">
      <MiniStat label="Ответ, медиана" value={minutesLabel(row?.medianMin ?? null)}
        sub={row ? `ответил на ${num(row.answered)} из ${num(row.waits)}` : 'обращений не было'} />
      <MiniStat label="Клиентов в час" value={perHour === null ? '—' : perHour.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}
        sub={`${num(leads)} за смены`} />
      <MiniStat label="Ждали > 15 мин" value={num(row?.over15 ?? 0)} sub="разных клиентов" />
    </div>
  )
}

export function StaffView({ data, speed }: { data: StaffData; speed?: StaffSpeedRow[] | { error: string } | null }) {
  const speedRows = Array.isArray(speed) ? speed : null
  return (
    <TabBody>
      <Lead>
        Всё, что было во время смены, засчитывается тем, кто был на смене. «Работа вместе» — засчитывается обоим.
        Смены обрезаются границами периода; открытая смена считается до текущего момента.
        Ответ — от обращения клиента (первое его сообщение после ответа человека или после передачи от бота) до
        следующего сообщения человека в этом чате; диалоги, которые целиком ведёт бот, сюда не входят.
        Клиентов в час — лиды смены на часы смены.
      </Lead>

      <div className="grid items-start gap-4 md:grid-cols-2 md:gap-5">
        {data.staff.length === 0 ? (
          <Card title="Сотрудники">
            <EmptyState icon={CalendarX} text="Смен за период не было"
              sub="Когда сотрудник откроет смену, здесь появятся его лиды, ответы, продажи, медиана времени ответа, клиентов в час и сколько клиентов ждали ответа дольше 15 минут." />
          </Card>
        ) : (
          data.staff.map((s) => (
            <section key={s.hours.staffId} className="min-w-0 rounded-2xl bg-white p-4 md:p-5"
              style={{ border: `1px solid ${LINE}`, boxShadow: '0 1px 2px rgba(23,16,42,0.04)' }}>
              <div className="mb-4 flex items-center gap-3">
                <Avatar name={s.hours.name} />
                <div className="min-w-0">
                  <h2 className="truncate text-[15px] font-semibold" style={{ color: INK }}>{s.hours.name}</h2>
                  <p className="text-[11px] leading-snug" style={{ color: INK_3 }}>
                    На смене <strong style={{ color: BRAND }}>{hours(s.hours.totalMs)}</strong>
                    {s.hours.togetherMs
                      ? `, из них вместе ${hours(s.hours.togetherMs)}: ${s.hours.withWhom.map((w) => `с ${w.name} — ${hours(w.ms)}`).join(', ')}`
                      : ', один'}
                  </p>
                </div>
              </div>
              {speedRows
                ? <SpeedStats row={speedRows.find((r) => r.staffId === s.hours.staffId)} leads={s.leads} hoursMs={s.hours.totalMs} />
                : <p className="mb-3 text-[11px]" style={{ color: INK_3 }}>
                    {speed && 'error' in speed ? `Скорость ответа не посчитана: ${speed.error}` : 'Считаем скорость ответа…'}
                  </p>}
              <WorkStats work={s} unansweredTotal={s.leads - s.answered} />
            </section>
          ))
        )}

        <Card icon={Moon} title="Вне смен" hint="Время, когда на смене не было никого: сообщения клиентов, ответы людей и заказы в эти моменты.">
          <WorkStats work={data.offShift} unansweredTotal={data.offShift.unansweredTotal} />
          {data.staff.length === 0 && <Note>Смен не было — поэтому сюда попадает весь период.</Note>}
        </Card>
      </div>
    </TabBody>
  )
}
