'use client'

// Вкладка «Передача от бота»: сколько чатов бот передал менеджеру, ответили
// ли им люди и как быстро, что бот успел до этого, сколько он вёл сам.
// Считает analytics_bot (supabase/migrations/049_…).

import { BadgeCheck, Gauge, Handshake, HelpCircle, ListChecks, ShoppingBag, Timer, UserRoundCheck, Hourglass } from 'lucide-react'
import { getBotHandoffAnalytics, type BotHandoffAnalytics } from '@/actions/analytics'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData, useReportStamp, type Stamp } from './useAnalyticsData'
import {
  Bars, Card, ErrorState, Expand, INK, INK_2, INK_3, Kpi, KpiGrid, Lead, MiniStat, Note, PersonRow, Ring, SERIES,
  ShowMore, Split, TabBody, TabSkeleton, WaitPill, num, pct, useNow,
} from './viz'

const minutes = (value: number | null) => {
  if (value === null) return '—'
  if (value < 1) return `${Math.round(value * 60)} сек`
  if (value < 60) return `${Math.round(value)} мин`
  const h = Math.floor(value / 60)
  return `${h} ч ${Math.round(value - h * 60)} мин`
}

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Bishkek', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso))

/** Метки бота → понятные шаги. Порядок — как идёт диалог. */
const STEPS: { key: string; label: string }[] = [
  { key: 'city-wait', label: 'Спросил город' },
  { key: 'results', label: 'Отправил фото до/после' },
  { key: 'results-delivery', label: 'Отправил блок результата с доставкой' },
  { key: 'post-results-stage', label: 'Ждал ответа после результата' },
  { key: 'discount13', label: 'Назвал скидку 13%' },
  { key: 'discount20', label: 'Назвал скидку 20%' },
  { key: 'promised', label: 'Клиент обещал вернуться позже' },
  { key: 'cod-wait', label: 'Предложил оплату при получении' },
  { key: 'order-placed', label: 'Оформил заказ сам' },
  { key: 'handed-off', label: 'Передал менеджеру' },
]

/** Остаток «не купили» — светлый шаг той же шкалы, не отдельная категория. */
const REST = '#ddd6ea'

export default function HandoffAnalytics({ period, onStamp }: { period: PeriodInput; onStamp?: (s: Stamp | null) => void }) {
  const { data, error, loading, loadedAt } = useAnalyticsData(getBotHandoffAnalytics, period)
  useReportStamp(data?.generatedAt, loadedAt, onStamp)
  if (error) return <ErrorState text={error} />
  if (loading || !data) return <TabSkeleton text="Считаем передачи от бота…" tiles={4} blocks={['bars', 'list', 'bars', 'bars']} />
  return <HandoffView data={data} />
}

export function HandoffView({ data }: { data: BotHandoffAnalytics }) {
  const now = useNow()
  const handedNotBought = data.handedOff - data.handedBought
  const steps = STEPS.map((s) => ({ label: s.label, value: data.steps[s.key] ?? 0 }))
  steps.push({ label: 'Отправил QR для оплаты', value: data.qrSent ?? 0 })

  return (
    <TabBody>
      <Lead>
        Передача — метка бота «передано менеджеру»: бот отправил карточку клиента в группу «Передача от бота» и дальше
        молчит. Если за сутки никто не ответил, бот шлёт карточку повторно — тогда считается время последней карточки.
      </Lead>

      <KpiGrid>
        <Kpi hero icon={Handshake} label="Передано менеджеру" value={num(data.handedOff)}
          sub={`${pct(data.handedOff, data.wrote)} от ${num(data.wrote)} писавших за период`} />
        <Kpi icon={Timer} label="Время до ответа (медиана)" value={minutes(data.handoffMedianMin)}
          sub={`дольше 15 мин — ${num(data.handoffOver15)}, дольше часа — ${num(data.handoffOver60)}`}
          rule="От передачи до первого сообщения человека. Медиана — половина случаев быстрее, половина медленнее." />
        <Kpi icon={Hourglass} tone={data.handedWaiting ? 'warn' : 'brand'} label="Без ответа человека" value={num(data.handedWaiting)}
          sub="после передачи человек так и не написал" />
        <Kpi icon={ShoppingBag} tone="good" label="Купили после передачи" value={num(data.handedBought)}
          sub={`заказ с номера после передачи · ${pct(data.handedBought, data.handedOff)}`} />
      </KpiGrid>

      <div className="grid items-start gap-4 md:grid-cols-2 md:gap-5">
        <Card icon={UserRoundCheck} title="Ответили ли после передачи" hint="Доля переданных чатов, где человек написал после передачи.">
          <div className="flex flex-wrap items-center gap-5">
            <Ring part={data.handedAnswered} whole={data.handedOff} label="Человек ответил после передачи" />
            <div className="flex min-w-0 flex-1 flex-col gap-3 text-sm">
              <div className="flex items-start gap-2">
                <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: SERIES[1] }} aria-hidden />
                <div>
                  <div style={{ color: INK }}><strong>{num(data.handedAnswered)}</strong> <span className="text-xs" style={{ color: INK_3 }}>из {num(data.handedOff)}</span></div>
                  <div className="text-xs" style={{ color: INK_2 }}>человек ответил после передачи</div>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: '#d5efeb' }} aria-hidden />
                <div>
                  <div style={{ color: INK }}><strong>{num(data.handedWaiting)}</strong></div>
                  <div className="text-xs" style={{ color: INK_2 }}>без ответа человека</div>
                </div>
              </div>
            </div>
          </div>
        </Card>

        <Card icon={BadgeCheck} title="Кто довёл до покупки"
          hint="Переданные менеджеру — против тех, кого бот вёл сам: чат не передан, человек не писал после первого сообщения клиента в периоде.">
          <div className="flex flex-col gap-4">
            <div>
              <div className="mb-1.5 text-xs font-semibold" style={{ color: INK }}>После передачи менеджеру</div>
              <Split
                left={{ label: 'Купили', value: data.handedBought, color: SERIES[1] }}
                right={{ label: 'Не купили', value: handedNotBought, color: REST }}
              />
            </div>
            <div>
              <div className="mb-1.5 text-xs font-semibold" style={{ color: INK }}>Бот вёл сам</div>
              <Split
                left={{ label: 'Купили', value: data.botOnlyBought, color: SERIES[0] }}
                right={{ label: 'Не купили', value: data.botOnly - data.botOnlyBought, color: REST }}
              />
            </div>
          </div>
          <Note>
            Конверсия: после передачи {pct(data.handedBought, data.handedOff)}, бот сам {pct(data.botOnlyBought, data.botOnly)}.
            Покупка — заказ в CRM с номера клиента.
          </Note>
        </Card>
      </div>

      {data.waiting.length > 0 && (
        <Card icon={Hourglass} title="Передано, но человек не ответил"
          hint={`Свежие сверху. «Ждёт» — время с момента передачи до сейчас.${data.handedWaiting > data.waiting.length ? ` Показаны ${num(data.waiting.length)} из ${num(data.handedWaiting)}.` : ''}`}>
          <ShowMore items={data.waiting} render={(r) => {
            const waitedMs = now - new Date(r.handedAt).getTime()
            return (
              <PersonRow key={r.chatId} name={r.name} dealId={r.dealId} chatId={r.chatId}
                detail={<span className="text-[11px]" style={{ color: INK_3 }}>передан {dateTime(r.handedAt)}</span>}
                right={<WaitPill ms={waitedMs} text={minutes(waitedMs / 60_000)} />}
              />
            )
          }} />
        </Card>
      )}

      <div className="grid items-start gap-4 md:grid-cols-2 md:gap-5">
        <Card icon={ListChecks} title="Что бот сделал за период"
          hint="Сколько разных клиентов получили каждый шаг бота в эти дни (по служебным меткам в переписке). Метка ставится один раз на клиента.">
          <Bars items={steps} />
        </Card>

        <Card icon={Gauge} title="Скорость первого ответа"
          hint="От первого сообщения клиента в периоде до первого ответа бота и первого ответа человека.">
          <div className="grid grid-cols-2 gap-2.5">
            <MiniStat label="Бот (медиана)" value={minutes(data.speed.botMedianMin)} sub={`ответил в ${num(data.speed.botAnswered)} чатах`} />
            <MiniStat label="Человек (медиана)" value={minutes(data.speed.humanMedianMin)} sub={`ответил в ${num(data.speed.humanAnswered)} чатах`} />
            <MiniStat label="Первый ответ дольше 15 мин" value={num(data.speed.firstReplyOver15)} sub="ни бот, ни человек" />
            <MiniStat label="Без ответа вообще" value={num(data.speed.noReplyAtAll)} />
          </div>
          <div className="mt-4">
            <Expand summary={<span className="flex items-center gap-1.5"><HelpCircle className="size-3.5" aria-hidden />Как считается</span>}>
              <ul className="list-disc pl-4 text-[11px] leading-relaxed" style={{ color: INK_3 }}>
                <li>Писавшие — клиенты WhatsApp, приславшие сообщение в эти дни (сотрудники смен не считаются).</li>
                <li>Ответ человека — сообщение с телефона или из CRM, кроме массовых рассылок.</li>
                <li>Ответ бота — его настоящие сообщения, без служебных меток и рассылок.</li>
                <li>Медиана — половина случаев быстрее, половина медленнее.</li>
              </ul>
            </Expand>
          </div>
        </Card>
      </div>
    </TabBody>
  )
}
