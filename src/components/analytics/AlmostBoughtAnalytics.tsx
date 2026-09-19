'use client'

// Вкладка «Почти купили»: клиенты, которые были готовы оплатить (QR, оплата
// при получении, этап «Готов к покупке»), но заказа с их номера так и нет.
// Рабочий список для менеджера. Считает analytics_almost_bought (053).

import { useState } from 'react'
import { BadgeCheck, CheckCheck, HandCoins, QrCode, Truck, Wallet } from 'lucide-react'
import {
  getAlmostBoughtAnalytics, type AlmostBoughtAnalytics, type AlmostRow, type ReadySignal,
} from '@/lib/analytics/client-api'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData, useReportStamp, type Stamp } from './useAnalyticsData'
import {
  BRAND, BRAND_SOFT, Card, EmptyState, ErrorState, INK_2, INK_3, Kpi, KpiGrid, Lead, PersonRow, ShowMore, TabBody,
  TabSkeleton, num, pct,
} from './viz'

const SIGNALS: { key: ReadySignal; label: string; short: string; icon: typeof QrCode; rule: string }[] = [
  { key: 'qr', label: 'Отправлен QR оплаты', short: 'QR', icon: QrCode,
    rule: 'Бот отправил клиенту QR для оплаты (сообщение «[QR оплаты]»).' },
  { key: 'cod', label: 'Предложена оплата при получении', short: 'При получении', icon: Truck,
    rule: 'Бот предложил оплату при получении и ждал адрес (служебная метка cod-wait).' },
  { key: 'ready', label: 'Этап «Готов к покупке»', short: '«Готов к покупке»', icon: BadgeCheck,
    rule: 'Сделку клиента перевели на этап «Готов к покупке» (история переходов сделки).' },
]

const AT: Record<ReadySignal, (r: AlmostRow) => string | null> = {
  qr: (r) => r.qrAt,
  cod: (r) => r.codAt,
  ready: (r) => r.readyAt,
}

const WHO: Record<'c' | 'h' | 'b', string> = { c: 'клиент', h: 'менеджер', b: 'бот' }

const time = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Bishkek', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function AlmostBoughtAnalytics({ period, onStamp }: { period: PeriodInput; onStamp?: (s: Stamp | null) => void }) {
  const { data, error, loading, loadedAt } = useAnalyticsData(getAlmostBoughtAnalytics, period)
  useReportStamp(data?.generatedAt, loadedAt, onStamp)
  if (error) return <ErrorState text={error} />
  if (loading || !data) return <TabSkeleton text="Ищем, кто почти купил…" blocks={['list']} />
  return <AlmostView data={data} />
}

/** Кто написал последним. Клиент — значит, ход за нами: выделяем. */
function LastBy({ row }: { row: AlmostRow }) {
  if (!row.lastBy || !row.lastMsgAt) return null
  const clientWaits = row.lastBy === 'c'
  return (
    <span
      className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-semibold"
      style={clientWaits ? { background: '#fdf3dc', color: '#8a5300' } : { background: '#f4f1f8', color: INK_2 }}
      title={`Последнее сообщение в чате — ${WHO[row.lastBy]}, ${time(row.lastMsgAt)}`}
    >
      {clientWaits ? 'ждёт ответа' : `последним — ${WHO[row.lastBy]}`}
    </span>
  )
}

export function AlmostView({ data }: { data: AlmostBoughtAnalytics }) {
  const [filter, setFilter] = useState<ReadySignal | 'all'>('all')
  const rows = filter === 'all' ? data.rows : data.rows.filter((r) => AT[filter](r) !== null)

  return (
    <TabBody>
      <Lead>
        Клиент, у которого в эти дни был сигнал готовности к оплате, — и после первого такого сигнала заказа с его номера
        (последние 9 цифр, не отменён) нет до сих пор. Заказ, созданный за час до сигнала или позже, считается покупкой:
        бот иногда переводит сделку на этап через минуту после заказа. Номера сотрудников и тестовые чаты не считаются.
      </Lead>

      <KpiGrid>
        <Kpi hero icon={HandCoins} label="Почти купили" value={num(data.almost)}
          sub={`из ${num(data.signaled)} с сигналом · купили ${num(data.bought)} (${pct(data.bought, data.signaled)})`}
          rule="Клиенты с сигналом готовности в периоде, у которых после первого сигнала нет заказа. Купили — остальные клиенты с сигналом." />
        {SIGNALS.map((s) => (
          <Kpi key={s.key} icon={s.icon} tone="warn" label={s.label} value={num(data.byKind[s.key])}
            sub={`без заказа · из ${num(data.signaledByKind[s.key])} с этим сигналом`}
            rule={`${s.rule} Один клиент может иметь несколько сигналов — тогда он в каждой плитке.`} />
        ))}
      </KpiGrid>

      <Card icon={Wallet} title="Кому написать"
        hint="Свежие сверху — по последнему сигналу. Имя — ссылка на сделку. Справа — кто написал в чате последним.">
        <div className="-mx-1 mb-3 overflow-x-auto px-1 [scrollbar-width:none]">
          <div className="flex w-max gap-1.5" role="radiogroup" aria-label="Сигнал">
            {[{ key: 'all' as const, short: 'Все', count: data.almost }, ...SIGNALS.map((s) => ({ key: s.key, short: s.short, count: data.byKind[s.key] }))]
              .map((f) => {
                const active = filter === f.key
                return (
                  <button key={f.key} type="button" role="radio" aria-checked={active} onClick={() => setFilter(f.key)}
                    className="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors"
                    style={active ? { background: BRAND, color: '#fff' } : { background: BRAND_SOFT, color: BRAND }}>
                    {f.short} · {num(f.count)}
                  </button>
                )
              })}
          </div>
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={CheckCheck} text={data.signaled ? 'Все, у кого был такой сигнал, заказали.' : 'Сигналов готовности за период не было.'} />
        ) : (
          <ShowMore key={filter} items={rows} initial={15} render={(r) => (
            <PersonRow key={r.chatId} name={r.name} dealId={r.dealId} chatId={r.chatId}
              detail={<>
                <span className="flex flex-wrap gap-x-2.5 gap-y-0.5">
                  {SIGNALS.map((s) => {
                    const at = AT[s.key](r)
                    return at && (
                      <span key={s.key} className="whitespace-nowrap">
                        <span className="font-semibold" style={{ color: INK_2 }}>{s.short}</span>{' '}
                        <span style={{ color: INK_3 }}>{time(at)}</span>
                      </span>
                    )
                  })}
                </span>
                {r.lastBy && r.lastMsgAt && (
                  <span className="text-[11px]" style={{ color: INK_3 }}>
                    последнее сообщение в чате — {time(r.lastMsgAt)}
                  </span>
                )}
              </>}
              right={<LastBy row={r} />}
            />
          )} />
        )}
      </Card>
    </TabBody>
  )
}
