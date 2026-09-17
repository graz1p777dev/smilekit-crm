'use client'

// Вкладка «Лиды и конверсия»: кто писал, кому ответили, кто сейчас ждёт,
// сколько новых купили и какие это клиенты. Каждая цифра — с правилом.

import { useEffect, useState } from 'react'
import { getLeadsAnalytics, type LeadsAnalytics, type ReplyGroup } from '@/actions/analytics'
import type { PeriodInput } from '@/lib/analytics/period'
import { CLIENT_TYPE_LABELS, formatDuration, type ClientType } from '@/lib/analytics/client-types'
import { useAnalyticsData } from './useAnalyticsData'
import {
  Card, ClientCell, Expand, INK, INK_2, INK_3, LINE, SERIES, ScrollTable, Stat, num, pct, phoneLabel,
} from './viz'

const TYPE_COLORS: Record<ClientType, string> = {
  iron: SERIES[1],
  regular: SERIES[0],
  air: SERIES[2],
  short: '#a8a1b5',
  midAnswered: '#a8a1b5',
  long: '#a8a1b5',
}

const time = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Bishkek', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** Тикает раз в минуту, чтобы «сколько ждёт» не застывало. */
function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}

export function Skeleton({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-3 p-4 md:p-8" aria-busy>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))' }}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-[84px] animate-pulse rounded-2xl bg-white" style={{ border: `1px solid ${LINE}` }} />
        ))}
      </div>
      <p className="text-sm" style={{ color: INK_3 }}>{text}</p>
    </div>
  )
}

function ConversionRow({ label, group }: { label: string; group: ReplyGroup }) {
  return (
    <tr style={{ borderTop: `1px solid ${LINE}` }}>
      <td className="py-2 pr-3">{label}</td>
      <td className="py-2 pr-3 tabular-nums">{num(group.leads)}</td>
      <td className="py-2 pr-3 tabular-nums">{num(group.bought)}</td>
      <td className="py-2 pr-3 tabular-nums font-semibold">{pct(group.bought, group.leads)}</td>
    </tr>
  )
}

export default function LeadsAnalyticsView({ period }: { period: PeriodInput }) {
  const { data, error, loading } = useAnalyticsData(getLeadsAnalytics, period)
  if (error) return <p className="p-8 text-sm" style={{ color: '#b91c1c' }}>{error}</p>
  if (loading || !data) return <Skeleton text="Считаем лиды…" />
  return <LeadsBody data={data} />
}

function LeadsBody({ data }: { data: LeadsAnalytics }) {
  const now = useNow()
  const c = data.conversion
  const typesSum = data.types.reduce((sum, t) => sum + t.count, 0)

  return (
    <div className="flex flex-col gap-5 p-4 md:p-8">
      <div>
        <h1 className="text-xl font-bold" style={{ color: INK }}>Лиды WhatsApp</h1>
        <p className="mt-0.5 text-xs" style={{ color: INK_3 }}>
          Лид — чат WhatsApp с номером клиента. Группы, тестовые чаты и номера сотрудников не считаются.
          Рассылки и служебные записи не считаются ни сообщением, ни ответом.
          {data.dataSince && <> Переписка в базе — с {new Date(data.dataSince).toLocaleDateString('ru-RU', { timeZone: 'Asia/Bishkek' })}.</>}
          {' '}Посчитано в {time(data.generatedAt)}.
        </p>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Stat label="Писали за период" value={num(data.wrote)} sub="чаты, где клиент написал в эти дни" />
        <Stat label="Новые" value={num(data.newLeads)} sub="самое первое сообщение клиента — в эти дни" />
        <Stat label="Ответил человек" value={num(data.human)} tone="good"
          sub="из писавших: человек написал после первого сообщения клиента в периоде (ответ мог прийти и после конца периода)" />
        <Stat label="Ответил только бот" value={num(data.botOnly)} sub="из писавших: после первого сообщения — только бот" />
        <Stat label="Без ответа вообще" value={num(data.noReply)} tone="warn" sub="из писавших: после первого сообщения не писал никто" />
        <Stat label="Сейчас без ответа" value={num(data.waitingTotal)} tone="warn"
          sub="из писавших: последнее сообщение в чате — от клиента" />
      </div>

      <Card
        title="Сейчас без ответа"
        hint={`Кто написал за период и до сих пор ждёт: последнее сообщение в диалоге — от клиента. «Ждёт» — с первого сообщения клиента, после которого не было ни человека, ни бота.${data.waitingTotal > data.waiting.length ? ` Показаны последние ${num(data.waiting.length)} из ${num(data.waitingTotal)}.` : ''}`}
      >
        {data.waiting.length === 0 ? (
          <p className="text-sm" style={{ color: INK_3 }}>Все, кто писал за период, получили ответ.</p>
        ) : (
          <ScrollTable head={['Клиент', 'Телефон', 'Ждёт', 'Последнее сообщение']}>
            {data.waiting.map((w) => (
              <tr key={w.chatId} style={{ borderTop: `1px solid ${LINE}` }}>
                <td className="py-2 pr-3"><ClientCell name={w.name} dealId={w.dealId} /></td>
                <td className="py-2 pr-3 tabular-nums whitespace-nowrap" style={{ color: INK_2 }}>{phoneLabel(w.chatId)}</td>
                <td className="py-2 pr-3 whitespace-nowrap font-semibold" style={{ color: '#c2410c' }}
                  title={`с ${time(w.since)}`}>
                  {formatDuration(now - Date.parse(w.since))}
                </td>
                <td className="py-2 pr-3" style={{ color: INK_2 }}>
                  <span className="line-clamp-2">{w.lastText || '[вложение без текста]'}</span>
                  <span className="text-[10px]" style={{ color: INK_3 }}>{time(w.lastAt)}</span>
                </td>
              </tr>
            ))}
          </ScrollTable>
        )}
      </Card>

      <div className="grid gap-5 md:grid-cols-2">
        <Card
          title="Конверсия новых лидов"
          hint="Берём новых лидов периода. Купил — есть заказ (не отменён) с тем же номером (последние 9 цифр), созданный после первого сообщения клиента, в любой момент до сейчас."
        >
          <div className="mb-3 flex items-baseline gap-2">
            <span className="text-[26px] font-bold tabular-nums" style={{ color: '#5115a4' }}>{pct(c.bought, data.newLeads)}</span>
            <span className="text-xs" style={{ color: INK_2 }}>
              купили {num(c.bought)} из {num(data.newLeads)} новых
            </span>
          </div>
          <ScrollTable head={['Кто отвечал', 'Новых', 'Купили', '%']}>
            <ConversionRow label="Отвечал человек" group={c.human} />
            <ConversionRow label="Только бот" group={c.botOnly} />
            <ConversionRow label="Никто не ответил" group={c.noReply} />
          </ScrollTable>
          <p className="mt-2 text-[11px]" style={{ color: INK_3 }}>
            «Отвечал человек» — человек написал в чат после первого сообщения клиента (в любой момент, в том числе после заказа).
          </p>
        </Card>

        <Card
          title="Типы клиентов"
          hint="Те же новые лиды периода. Сообщения диалога — клиент, человек и бот."
        >
          <div className="flex flex-col gap-2">
            {data.types.map((t) => (
              <Expand
                key={t.type}
                summary={
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="flex items-center gap-1.5 font-semibold" style={{ color: INK }}>
                        <span className="size-2.5 shrink-0 rounded-full" style={{ background: TYPE_COLORS[t.type] }} aria-hidden />
                        {CLIENT_TYPE_LABELS[t.type].title}
                      </span>
                      <span className="shrink-0 tabular-nums" style={{ color: INK }}>
                        {num(t.count)} <span style={{ color: INK_3 }}>· {pct(t.count, data.newLeads)}</span>
                      </span>
                    </span>
                    <span className="text-[11px]" style={{ color: INK_3 }}>{CLIENT_TYPE_LABELS[t.type].rule}</span>
                  </span>
                }
              >
                {t.clients.length === 0 ? (
                  <p className="text-xs" style={{ color: INK_3 }}>Таких нет.</p>
                ) : (
                  <>
                    {t.count > t.clients.length && (
                      <p className="mb-1 text-[11px]" style={{ color: INK_3 }}>
                        Показаны последние {num(t.clients.length)} из {num(t.count)}.
                      </p>
                    )}
                    <ScrollTable head={t.type === 'iron' || t.type === 'regular'
                      ? ['Клиент', 'Телефон', 'Сообщений до заказа', 'Время до заказа']
                      : ['Клиент', 'Телефон', 'Сообщений всего']}>
                      {t.clients.map((row) => (
                        <tr key={row.chatId} style={{ borderTop: `1px solid ${LINE}` }}>
                          <td className="py-1.5 pr-3"><ClientCell name={row.name} dealId={row.dealId} /></td>
                          <td className="py-1.5 pr-3 tabular-nums whitespace-nowrap" style={{ color: INK_2 }}>{phoneLabel(row.chatId)}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{num(row.msgsBeforeOrder ?? row.totalMsgs)}</td>
                          {row.msToOrder !== null && (
                            <td className="py-1.5 pr-3 tabular-nums whitespace-nowrap">{formatDuration(row.msToOrder)}</td>
                          )}
                        </tr>
                      ))}
                    </ScrollTable>
                  </>
                )}
              </Expand>
            ))}
          </div>
          <p className="mt-3 text-[11px]" style={{ color: typesSum === data.newLeads ? INK_3 : '#b91c1c' }}>
            Сумма типов: {num(typesSum)} {typesSum === data.newLeads ? '= новые лиды' : `≠ новые лиды (${num(data.newLeads)})`}
          </p>
        </Card>
      </div>
    </div>
  )
}
