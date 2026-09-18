'use client'

// Вкладка «Лиды и конверсия»: кто писал, кому ответили, кто сейчас ждёт,
// сколько новых купили и какие это клиенты. Каждая цифра — с правилом.

import { Hourglass, MessagesSquare, PieChart, Reply, Target, UserPlus, CheckCheck } from 'lucide-react'
import { getLeadsAnalytics, type LeadsAnalytics, type ReplyGroup } from '@/actions/analytics'
import type { PeriodInput } from '@/lib/analytics/period'
import { CLIENT_TYPE_LABELS, formatDuration, type ClientType } from '@/lib/analytics/client-types'
import { useAnalyticsData, useReportStamp, type Stamp } from './useAnalyticsData'
import {
  BRAND, Card, ClientCell, EmptyState, ErrorState, Expand, INK, INK_2, INK_3, Kpi, KpiGrid, LINE, Lead, Note, OTHER,
  PersonRow, SERIES, ScrollTable, SegmentBar, ShowMore, TRACK, TabBody, TabSkeleton, WaitPill, num, pct, phoneLabel, useNow,
} from './viz'

const TYPE_COLORS: Record<ClientType, string> = {
  iron: SERIES[1],
  regular: SERIES[0],
  air: SERIES[2],
  short: OTHER,
  midAnswered: OTHER,
  long: OTHER,
}

/** Кто отвечал: один и тот же цвет у группы во всех блоках вкладки. */
const REPLY_COLORS = { human: SERIES[1], botOnly: SERIES[0], noReply: SERIES[2] } as const

const time = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Bishkek', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function LeadsAnalyticsView({ period, onStamp }: { period: PeriodInput; onStamp?: (s: Stamp | null) => void }) {
  const { data, error, loading, loadedAt } = useAnalyticsData(getLeadsAnalytics, period)
  useReportStamp(data?.generatedAt, loadedAt, onStamp)
  if (error) return <ErrorState text={error} />
  if (loading || !data) return <TabSkeleton text="Считаем лиды…" blocks={['bars', 'list', 'bars', 'bars']} />
  return <LeadsView data={data} />
}

/** Конверсия группы: крупно — доля, рядом — «купили из». */
function GroupRate({ label, group, color, top }: { label: string; group: ReplyGroup; color: string; top: number }) {
  const rate = group.leads ? group.bought / group.leads : 0
  return (
    <div title={`${label}: купили ${num(group.bought)} из ${num(group.leads)}`}>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-1.5" style={{ color: INK }}>
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
          <span className="truncate">{label}</span>
        </span>
        <span className="shrink-0 tabular-nums" style={{ color: INK_3 }}>
          {num(group.bought)} из {num(group.leads)} · <strong style={{ color: INK }}>{pct(group.bought, group.leads)}</strong>
        </span>
      </div>
      <div className="h-2 rounded-full" style={{ background: TRACK }}>
        {rate > 0 && <div className="h-full rounded-full" style={{ width: `${Math.max(1.5, (rate / top) * 100)}%`, background: color }} />}
      </div>
    </div>
  )
}

export function LeadsView({ data }: { data: LeadsAnalytics }) {
  const now = useNow()
  const c = data.conversion
  const typesSum = data.types.reduce((sum, t) => sum + t.count, 0)
  const typeCount = (type: ClientType) => data.types.find((t) => t.type === type)?.count ?? 0
  const otherTypes = typesSum - typeCount('iron') - typeCount('regular') - typeCount('air')
  const groups = [
    { label: 'Отвечал человек', group: c.human, color: REPLY_COLORS.human },
    { label: 'Только бот', group: c.botOnly, color: REPLY_COLORS.botOnly },
    { label: 'Никто не ответил', group: c.noReply, color: REPLY_COLORS.noReply },
  ]
  const topRate = Math.max(...groups.map((g) => (g.group.leads ? g.group.bought / g.group.leads : 0)), 0.0001)

  return (
    <TabBody>
      <Lead>
        Лид — чат WhatsApp с номером клиента. Группы, тестовые чаты и номера сотрудников не считаются.
        Рассылки и служебные записи не считаются ни сообщением, ни ответом.
        {data.dataSince && <> Переписка в базе — с {new Date(data.dataSince).toLocaleDateString('ru-RU', { timeZone: 'Asia/Bishkek' })}.</>}
      </Lead>

      <KpiGrid>
        <Kpi hero icon={MessagesSquare} label="Писали за период" value={num(data.wrote)}
          sub="чаты, где клиент написал в эти дни" />
        <Kpi icon={UserPlus} label="Новые" value={num(data.newLeads)}
          sub="самое первое сообщение клиента — в эти дни" />
        <Kpi icon={Target} tone="good" label="Купили из новых" value={pct(c.bought, data.newLeads)}
          sub={`${num(c.bought)} из ${num(data.newLeads)} новых`}
          rule="Купил — есть заказ (не отменён) с тем же номером (последние 9 цифр), созданный после первого сообщения клиента, в любой момент до сейчас." />
        <Kpi icon={Hourglass} tone="warn" label="Сейчас без ответа" value={num(data.waitingTotal)}
          sub="из писавших: последнее сообщение в чате — от клиента" />
      </KpiGrid>

      <Card icon={Reply} title="Кто ответил писавшим"
        hint="Из писавших за период: кто написал в чат после первого сообщения клиента в периоде. Ответ мог прийти и после конца периода.">
        <SegmentBar total={data.wrote} segments={[
          { label: 'Ответил человек', value: data.human, color: REPLY_COLORS.human, note: 'человек написал после первого сообщения клиента' },
          { label: 'Ответил только бот', value: data.botOnly, color: REPLY_COLORS.botOnly, note: 'после первого сообщения — только бот' },
          { label: 'Без ответа вообще', value: data.noReply, color: REPLY_COLORS.noReply, note: 'после первого сообщения не писал никто' },
        ]} />
      </Card>

      <Card icon={Hourglass} title="Сейчас без ответа"
        hint={`Кто написал за период и до сих пор ждёт: последнее сообщение в диалоге — от клиента. «Ждёт» — с первого сообщения клиента, после которого не было ни человека, ни бота.${data.waitingTotal > data.waiting.length ? ` Показаны последние ${num(data.waiting.length)} из ${num(data.waitingTotal)}.` : ''}`}>
        {data.waiting.length === 0 ? (
          <EmptyState icon={CheckCheck} text="Все, кто писал за период, получили ответ." />
        ) : (
          <ShowMore items={data.waiting} render={(w) => {
            const waited = now - Date.parse(w.since)
            return (
              <PersonRow key={w.chatId} name={w.name} dealId={w.dealId} chatId={w.chatId}
                detail={<>
                  <span className="line-clamp-1" style={{ color: INK_2 }}>{w.lastText || '[вложение без текста]'}</span>
                  <span className="text-[11px]" style={{ color: INK_3 }}>последнее — {time(w.lastAt)}</span>
                </>}
                right={<WaitPill ms={waited} text={formatDuration(waited)} title={`ждёт с ${time(w.since)}`} />}
              />
            )
          }} />
        )}
      </Card>

      <div className="grid items-start gap-4 md:grid-cols-2 md:gap-5">
        <Card icon={Target} title="Конверсия новых лидов"
          hint="Берём новых лидов периода. Купил — есть заказ (не отменён) с тем же номером (последние 9 цифр), созданный после первого сообщения клиента, в любой момент до сейчас.">
          <div className="mb-5 flex flex-wrap items-end gap-x-3 gap-y-1">
            <span className="text-[40px] font-bold leading-none tracking-tight" style={{ color: BRAND }}>{pct(c.bought, data.newLeads)}</span>
            <span className="pb-1 text-xs" style={{ color: INK_2 }}>купили {num(c.bought)} из {num(data.newLeads)} новых</span>
          </div>
          <div className="flex flex-col gap-3.5">
            {groups.map((g) => <GroupRate key={g.label} {...g} top={topRate} />)}
          </div>
          <Note>
            «Отвечал человек» — человек написал в чат после первого сообщения клиента (в любой момент, в том числе после заказа).
            Полосы сравнивают доли купивших между группами.
          </Note>
        </Card>

        <Card icon={PieChart} title="Типы клиентов" hint="Те же новые лиды периода. Сообщения диалога — клиент, человек и бот.">
          <SegmentBar total={data.newLeads} columns={2} segments={[
            { label: CLIENT_TYPE_LABELS.iron.title, value: typeCount('iron'), color: TYPE_COLORS.iron },
            { label: CLIENT_TYPE_LABELS.regular.title, value: typeCount('regular'), color: TYPE_COLORS.regular },
            { label: CLIENT_TYPE_LABELS.air.title, value: typeCount('air'), color: TYPE_COLORS.air },
            { label: 'Прочие', value: otherTypes, color: OTHER },
          ]} />
          <div className="mt-4 flex flex-col gap-2">
            {data.types.map((t) => (
              <Expand
                key={t.type}
                summary={
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2 font-semibold" style={{ color: INK }}>
                        <span className="size-2.5 shrink-0 rounded-full" style={{ background: TYPE_COLORS[t.type] }} aria-hidden />
                        <span className="truncate">{CLIENT_TYPE_LABELS[t.type].title}</span>
                      </span>
                      <span className="shrink-0 tabular-nums" style={{ color: INK }}>
                        <strong>{num(t.count)}</strong> <span style={{ color: INK_3 }}>· {pct(t.count, data.newLeads)}</span>
                      </span>
                    </span>
                    <span className="pl-[18px] text-[11px] leading-snug" style={{ color: INK_3 }}>{CLIENT_TYPE_LABELS[t.type].rule}</span>
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
                    <ScrollTable minWidth={440} head={t.type === 'iron' || t.type === 'regular'
                      ? ['Клиент', 'Телефон', 'Сообщений до заказа', 'Время до заказа']
                      : ['Клиент', 'Телефон', 'Сообщений всего']}>
                      {t.clients.map((row) => (
                        <tr key={row.chatId} style={{ borderTop: `1px solid ${LINE}` }}>
                          <td className="py-1.5 pr-3"><ClientCell name={row.name} dealId={row.dealId} /></td>
                          <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums" style={{ color: INK_2 }}>{phoneLabel(row.chatId)}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{num(row.msgsBeforeOrder ?? row.totalMsgs)}</td>
                          {row.msToOrder !== null && (
                            <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums">{formatDuration(row.msToOrder)}</td>
                          )}
                        </tr>
                      ))}
                    </ScrollTable>
                  </>
                )}
              </Expand>
            ))}
          </div>
          <Note tone={typesSum === data.newLeads ? undefined : 'bad'}>
            Сумма типов: {num(typesSum)} {typesSum === data.newLeads ? '= новые лиды' : `≠ новые лиды (${num(data.newLeads)})`}.
            «Прочие» на полосе — три последние группы списка.
          </Note>
        </Card>
      </div>
    </TabBody>
  )
}
