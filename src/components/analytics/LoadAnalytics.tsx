'use client'

// Вкладка «Нагрузка»: когда пишут клиенты (день недели × час, время Бишкека)
// и как быстро им отвечают по часам. Считает analytics_load (055).

import { useState } from 'react'
import { CalendarClock, Clock, Flame, Hourglass, Timer } from 'lucide-react'
import { getLoadAnalytics, type LoadAnalytics } from '@/lib/analytics/client-api'
import { daysOf, type PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData, useReportStamp, type Stamp } from './useAnalyticsData'
import {
  Card, EmptyState, ErrorState, INK, INK_2, INK_3, Kpi, KpiGrid, LINE, Lead, SERIES, ScrollTable, TRACK, TabBody,
  TabSkeleton, num, pct,
} from './viz'

/**
 * Последовательная шкала — один фиолетовый тон, светлый → тёмный (валидатор
 * dataviz: монотонная светлота, шаги ≥ 0.06, один тон). Самый светлый шаг —
 * «мало», ноль — отдельная нейтральная клетка без заливки тоном.
 */
const HEAT = ['#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#6d28d9', '#4c1d95'] as const
const ZERO = '#f5f3f9'
const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const DOW_LONG = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье']
const DOW_PLURAL = ['понедельников', 'вторников', 'сред', 'четвергов', 'пятниц', 'суббот', 'воскресений']

const heatColor = (value: number, max: number) =>
  value <= 0 || max <= 0 ? ZERO : HEAT[Math.min(HEAT.length - 1, Math.ceil((value / max) * HEAT.length) - 1)]

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`

export const minutesLabel = (value: number | null) => {
  if (value === null) return '—'
  if (value < 1) return `${Math.round(value * 60)} сек`
  if (value < 60) return `${Math.round(value)} мин`
  const h = Math.floor(value / 60)
  return `${h} ч ${Math.round(value - h * 60)} мин`
}

export default function LoadAnalyticsTab({ period, onStamp }: { period: PeriodInput; onStamp?: (s: Stamp | null) => void }) {
  const { data, error, loading, loadedAt } = useAnalyticsData(getLoadAnalytics, period)
  useReportStamp(data?.generatedAt, loadedAt, onStamp)
  if (error) return <ErrorState text={error} />
  if (loading || !data) return <TabSkeleton text="Считаем нагрузку…" blocks={['chart', 'bars']} />
  return <LoadView data={data} />
}

function Heatmap({ data }: { data: LoadAnalytics }) {
  const [active, setActive] = useState<{ d: number; h: number } | null>(null)
  const grid = new Map(data.heat.map(([d, h, n]) => [`${d}:${h}`, n]))
  const max = Math.max(0, ...data.heat.map(([, , n]) => n))
  // Сколько раз каждый день недели встречается в периоде — для подсказки.
  const dowCount = [0, 0, 0, 0, 0, 0, 0]
  for (const day of daysOf(data.range)) dowCount[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]++

  const tip = (d: number, h: number) => {
    const n = grid.get(`${d}:${h}`) ?? 0
    return `${DOW_LONG[d - 1]}, ${hh(h)}–${String(h).padStart(2, '0')}:59 — ${num(n)} разных клиентов написали (${DOW_PLURAL[d - 1]} в периоде: ${dowCount[d - 1]})`
  }

  return (
    <div>
      <div className="relative" onMouseLeave={() => setActive(null)}>
        <div className="grid gap-[2px]" style={{ gridTemplateColumns: '22px repeat(24, minmax(0, 1fr))' }} role="img"
          aria-label="Сколько разных клиентов писали по дням недели и часам">
          {DOW.map((label, di) => {
            const d = di + 1
            return [
              <div key={`l${d}`} className="flex items-center text-[10px] font-medium" style={{ color: INK_3 }}>{label}</div>,
              ...Array.from({ length: 24 }, (_, h) => {
                const n = grid.get(`${d}:${h}`) ?? 0
                const on = active?.d === d && active.h === h
                return (
                  <button key={`${d}:${h}`} type="button" title={tip(d, h)} aria-label={tip(d, h)}
                    onMouseEnter={() => setActive({ d, h })} onFocus={() => setActive({ d, h })} onClick={() => setActive({ d, h })}
                    className="aspect-square min-h-[10px] rounded-[3px] outline-none"
                    style={{ background: heatColor(n, max), boxShadow: on ? `0 0 0 2px #fff, 0 0 0 3.5px ${INK}` : undefined }} />
                )
              }),
            ]
          })}
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={`h${h}`} className="text-center text-[9px] tabular-nums" style={{ color: INK_3 }}>{h % 3 === 0 ? h : ''}</div>
          ))}
        </div>
      </div>
      <p className="mt-2 min-h-[32px] rounded-lg px-2.5 py-1.5 text-[11px] leading-snug" style={{ background: '#f8f6fc', color: active ? INK : INK_3 }}>
        {active ? tip(active.d, active.h) : 'Наведите или нажмите на клетку — покажем число.'}
      </p>
      <div className="mt-3 flex items-center gap-2 text-[10px]" style={{ color: INK_3 }}>
        <span className="flex items-center gap-1"><span className="size-2.5 rounded-[3px]" style={{ background: ZERO, border: `1px solid ${LINE}` }} />0</span>
        <span>1</span>
        <span className="flex gap-[2px]" aria-hidden>
          {HEAT.map((c) => <span key={c} className="h-2.5 w-5 rounded-[2px]" style={{ background: c }} />)}
        </span>
        <span>{num(max)} клиентов</span>
      </div>
    </div>
  )
}

export function LoadView({ data }: { data: LoadAnalytics }) {
  const peak = data.heat.reduce<[number, number, number] | null>((best, c) => (!best || c[2] > best[2] ? c : best), null)
  const firstTotal = data.hours.reduce((s, h) => s + h.clients, 0)
  const over15Total = data.hours.reduce((s, h) => s + h.over15, 0)
  const worstWait = data.hours.reduce<LoadAnalytics['hours'][number] | null>((best, h) => (!best || h.over15 > best.over15 ? h : best), null)
  const maxOver = Math.max(1, ...data.hours.map((h) => h.over15))

  return (
    <TabBody>
      <Lead>
        Время — Бишкек. Клиент — чат WhatsApp с номером клиента (без сотрудников и тестовых чатов). Ответ бота — его
        настоящие сообщения, ответ человека — с телефона или из CRM, без рассылок и служебных меток.
      </Lead>

      <KpiGrid>
        <Kpi hero icon={Flame} label="Самый загруженный час" value={peak ? `${DOW[peak[0] - 1]} ${hh(peak[1])}` : '—'}
          sub={peak ? `${num(peak[2])} разных клиентов написали в этот час` : 'сообщений не было'} />
        <Kpi icon={CalendarClock} label="Писали за период" value={num(firstTotal)} sub="разных клиентов" />
        <Kpi icon={Hourglass} tone="warn" label="Ждали первого ответа > 15 мин" value={num(over15Total)}
          sub={`${pct(over15Total, firstTotal)} от писавших`}
          rule="По первому сообщению клиента в периоде: первый ответ (бота или человека) пришёл позже 15 минут, или ответа нет, а с сообщения прошло больше 15 минут." />
        <Kpi icon={Timer} label="Хуже всего с ожиданием" value={worstWait && worstWait.over15 ? hh(worstWait.hour) : '—'}
          sub={worstWait && worstWait.over15 ? `${num(worstWait.over15)} ждали дольше 15 мин` : 'никто не ждал дольше 15 мин'} />
      </KpiGrid>

      <Card icon={CalendarClock} title="Когда пишут клиенты" wide
        hint="Клетка — день недели и час. Число — сколько разных клиентов прислали хотя бы одно сообщение в этот час (за все такие дни периода вместе). Темнее — больше.">
        {data.heat.length === 0 ? <EmptyState icon={CalendarClock} text="Сообщений клиентов за период нет" /> : <Heatmap data={data} />}
      </Card>

      <Card icon={Clock} title="Первый ответ по часам" wide
        hint="Час первого сообщения клиента в периоде (одна точка на клиента). «Бот» и «Человек» — медиана времени до их первого ответа: половина быстрее, половина медленнее; считается по тем, кому ответили.">
        {data.hours.length === 0 ? <EmptyState icon={Clock} text="Сообщений клиентов за период нет" /> : (
          <ScrollTable minWidth={330} head={['Час', 'Писали', 'Бот', 'Человек', 'Ждали > 15 мин']}>
            {data.hours.map((h) => (
              <tr key={h.hour} style={{ borderTop: `1px solid ${LINE}` }}
                title={`${hh(h.hour)}: писали ${h.clients}; бот ответил ${h.botAnswered}, человек ответил ${h.humanAnswered}; ждали дольше 15 мин — ${h.over15}`}>
                <td className="py-1.5 pr-3 font-medium tabular-nums">{hh(h.hour)}</td>
                <td className="py-1.5 pr-3 tabular-nums">{num(h.clients)}</td>
                <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums" style={{ color: INK_2 }}>{minutesLabel(h.botMedianMin)}</td>
                <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums" style={{ color: INK_2 }}>{minutesLabel(h.humanMedianMin)}</td>
                <td className="py-1.5 pr-1">
                  <div className="flex items-center gap-2 tabular-nums">
                    <span className="w-7 shrink-0 text-right font-semibold" style={{ color: h.over15 ? INK : INK_3 }}>{num(h.over15)}</span>
                    <span className="h-1.5 w-10 shrink-0 rounded-full" style={{ background: TRACK }} aria-hidden>
                      {h.over15 > 0 && <span className="block h-full rounded-full" style={{ width: `${Math.max(8, (h.over15 / maxOver) * 100)}%`, background: SERIES[2] }} />}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </ScrollTable>
        )}
      </Card>
    </TabBody>
  )
}
