'use client'

// Вкладка «Передача от бота»: сколько чатов бот передал менеджеру, ответили
// ли им люди и как быстро, что бот успел до этого, сколько он вёл сам.
// Считает analytics_bot (supabase/migrations/049_…).

import { getBotHandoffAnalytics } from '@/actions/analytics'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData } from './useAnalyticsData'
import { Skeleton } from './ConversionAnalytics'
import { Bars, Card, ClientCell, Expand, INK_2, INK_3, LINE, ScrollTable, Split, SERIES, Stat, num, pct, phoneLabel } from './viz'

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

const waitedFor = (iso: string) => minutes((Date.now() - new Date(iso).getTime()) / 60_000)

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

export default function HandoffAnalytics({ period }: { period: PeriodInput }) {
  const { data, error, loading } = useAnalyticsData(getBotHandoffAnalytics, period)
  if (error) return <p className="p-8 text-sm" style={{ color: '#b91c1c' }}>{error}</p>
  if (loading || !data) return <Skeleton text="Считаем передачи от бота…" />

  const handedNotBought = data.handedOff - data.handedBought
  const steps = STEPS.map((s) => ({ label: s.label, value: data.steps[s.key] ?? 0 }))
  steps.push({ label: 'Отправил QR для оплаты', value: data.qrSent ?? 0 })

  return (
    <div className="flex flex-col gap-5 p-4 md:p-8">
      <p className="text-xs" style={{ color: INK_3 }}>
        Передача — метка бота «передано менеджеру»: бот отправил карточку клиента в группу «Передача от бота» и дальше
        молчит. Если за сутки никто не ответил, бот шлёт карточку повторно — тогда считается время последней карточки.
      </p>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Stat label="Передано менеджеру" value={num(data.handedOff)}
          sub={`${pct(data.handedOff, data.wrote)} от ${num(data.wrote)} писавших за период`} />
        <Stat label="Человек ответил после передачи" value={num(data.handedAnswered)} tone="good"
          sub={pct(data.handedAnswered, data.handedOff)} />
        <Stat label="Без ответа человека" value={num(data.handedWaiting)} tone={data.handedWaiting ? 'warn' : 'brand'}
          sub="после передачи человек так и не написал" />
        <Stat label="Время до ответа (медиана)" value={minutes(data.handoffMedianMin)}
          sub={`от передачи до первого сообщения человека; дольше 15 мин — ${num(data.handoffOver15)}, дольше часа — ${num(data.handoffOver60)}`} />
        <Stat label="Купили после передачи" value={num(data.handedBought)} tone="good"
          sub={`заказ с номера после передачи · ${pct(data.handedBought, data.handedOff)}`} />
      </div>

      {data.waiting.length > 0 && (
        <Card title="Передано, но человек не ответил"
          hint="Свежие сверху. «Ждёт» — время с момента передачи до сейчас.">
          {data.handedWaiting > data.waiting.length && (
            <p className="mb-1 text-[11px]" style={{ color: INK_3 }}>Показаны {num(data.waiting.length)} из {num(data.handedWaiting)}.</p>
          )}
          <ScrollTable head={['Клиент', 'Телефон', 'Передан', 'Ждёт']}>
            {data.waiting.map((r) => (
              <tr key={r.chatId} style={{ borderTop: `1px solid ${LINE}` }}>
                <td className="py-1.5 pr-3"><ClientCell name={r.name} dealId={r.dealId} /></td>
                <td className="py-1.5 pr-3 tabular-nums" style={{ color: INK_2 }}>{phoneLabel(r.chatId)}</td>
                <td className="py-1.5 pr-3 tabular-nums">{dateTime(r.handedAt)}</td>
                <td className="py-1.5 pr-3 tabular-nums">{waitedFor(r.handedAt)}</td>
              </tr>
            ))}
          </ScrollTable>
        </Card>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <Card title="Кто довёл до покупки"
          hint="Переданные менеджеру — против тех, кого бот вёл сам: чат не передан, человек не писал после первого сообщения клиента в периоде.">
          <div className="flex flex-col gap-4">
            <Split
              left={{ label: 'Передано, купили', value: data.handedBought, color: SERIES[1] }}
              right={{ label: 'Передано, не купили', value: handedNotBought, color: '#d6d0e2' }}
            />
            <Split
              left={{ label: 'Бот сам, купили', value: data.botOnlyBought, color: SERIES[0] }}
              right={{ label: 'Бот сам, не купили', value: data.botOnly - data.botOnlyBought, color: '#d6d0e2' }}
            />
            <p className="text-[11px]" style={{ color: INK_3 }}>
              Конверсия: после передачи {pct(data.handedBought, data.handedOff)}, бот сам {pct(data.botOnlyBought, data.botOnly)}.
              Покупка — заказ в CRM с номера клиента.
            </p>
          </div>
        </Card>

        <Card title="Скорость первого ответа"
          hint="От первого сообщения клиента в периоде до первого ответа бота и первого ответа человека.">
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            <Stat label="Бот (медиана)" value={minutes(data.speed.botMedianMin)} sub={`ответил в ${num(data.speed.botAnswered)} чатах`} />
            <Stat label="Человек (медиана)" value={minutes(data.speed.humanMedianMin)} sub={`ответил в ${num(data.speed.humanAnswered)} чатах`} />
            <Stat label="Первый ответ дольше 15 мин" value={num(data.speed.firstReplyOver15)} tone="warn" sub="ни бот, ни человек" />
            <Stat label="Без ответа вообще" value={num(data.speed.noReplyAtAll)} tone={data.speed.noReplyAtAll ? 'warn' : 'brand'} />
          </div>
        </Card>
      </div>

      <Card title="Что бот сделал за период"
        hint="Сколько разных клиентов получили каждый шаг бота в эти дни (по служебным меткам в переписке). Метка ставится один раз на клиента.">
        <Bars items={steps} />
      </Card>

      <Expand summary={<span>Как считается</span>}>
        <ul className="list-disc pl-4 text-[11px]" style={{ color: INK_3 }}>
          <li>Писавшие — клиенты WhatsApp, приславшие сообщение в эти дни (сотрудники смен не считаются).</li>
          <li>Ответ человека — сообщение с телефона или из CRM, кроме массовых рассылок.</li>
          <li>Ответ бота — его настоящие сообщения, без служебных меток и рассылок.</li>
          <li>Медиана — половина случаев быстрее, половина медленнее.</li>
        </ul>
      </Expand>
    </div>
  )
}
