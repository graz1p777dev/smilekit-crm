'use client'

// Чеки и способы оплаты по заказам периода — по тексту, который бот пишет в
// начало заказа. Считает analytics_receipts (060).

import { ReceiptText } from 'lucide-react'
import { getReceiptsAnalytics, type ReceiptKind, type ReceiptsAnalytics } from '@/lib/analytics/client-api'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData } from './useAnalyticsData'
import { Card, EmptyState, INK, INK_3, Note, SERIES, TRACK, money, num } from './viz'

const KINDS: { key: ReceiptKind; label: string; rule: string }[] = [
  { key: 'verified', label: 'Чек прошёл автопроверку', rule: '«Чек проверен (WhatsApp)»' },
  { key: 'unchecked', label: 'Не проверен автоматически', rule: '«Чек не проверен автоматически»' },
  { key: 'rejected', label: 'Автопроверка отклонила', rule: '«Чек не прошёл проверку»' },
  { key: 'manager', label: 'Чек в чате менеджера', rule: '«Чек об оплате, чат вёл менеджер»' },
  { key: 'cod', label: 'Оплата при получении', rule: '«Оплата при получении»' },
  { key: 'other', label: 'Прочие заказы', rule: 'остальные: Telegram-бот, созданные вручную' },
]

export default function ReceiptsCard({ period }: { period: PeriodInput }) {
  const { data, error, loading } = useAnalyticsData(getReceiptsAnalytics, period)
  if (error) return <Card icon={ReceiptText} title="Чеки и оплата"><Note tone="bad">Не удалось посчитать: {error}</Note></Card>
  if (loading || !data) {
    return (
      <Card icon={ReceiptText} title="Чеки и оплата" hint="Считаем…">
        <div className="flex animate-pulse flex-col gap-3" aria-busy>
          {[60, 40, 20].map((w) => <div key={w} className="h-2.5 rounded-full" style={{ width: `${w}%`, background: TRACK }} />)}
        </div>
      </Card>
    )
  }
  return <ReceiptsView data={data} />
}

export function ReceiptsView({ data }: { data: ReceiptsAnalytics }) {
  const rows = KINDS.map((k) => ({ ...k, g: data.kinds[k.key] ?? { orders: 0, sum: 0, withAmount: 0, noAmount: 0 } }))
  const total = rows.reduce((s, r) => s + r.g.orders, 0)
  const top = Math.max(1, ...rows.map((r) => r.g.orders))
  return (
    <Card icon={ReceiptText} title="Чеки и оплата" wide
      hint="Заказы периода (кроме отменённых и удалённых) по тому, как пришла оплата: вид — по началу текста заказа, который пишет бот WhatsApp. Сумма — только где она указана в заказе.">
      {total === 0 ? <EmptyState icon={ReceiptText} text="За период заказов нет" /> : (
        <div className="flex flex-col gap-3">
          {rows.map((r) => (
            <div key={r.key} title={`${r.label}: ${num(r.g.orders)} зак. Правило: ${r.rule}.`}>
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                <span style={{ color: r.g.orders ? INK : INK_3 }}>
                  {r.label} <span className="text-[11px]" style={{ color: INK_3 }}>· {r.rule}</span>
                </span>
                <span className="tabular-nums" style={{ color: INK_3 }}>
                  <strong style={{ color: r.g.orders ? INK : INK_3 }}>{num(r.g.orders)}</strong>
                  {r.g.orders > 0 && (
                    <> · {r.g.withAmount ? money(r.g.sum) : 'суммы нет'}
                      {r.g.withAmount > 0 && r.g.noAmount > 0 && ` (без суммы ${num(r.g.noAmount)})`}</>
                  )}
                </span>
              </div>
              <div className="h-2 rounded-full" style={{ background: TRACK }}>
                {r.g.orders > 0 && <div className="h-full rounded-full" style={{ width: `${Math.max(1.5, (r.g.orders / top) * 100)}%`, background: SERIES[0] }} />}
              </div>
            </div>
          ))}
          <Note>
            Всего {num(total)} зак.; сумма указана у {num(rows.reduce((s, r) => s + r.g.withAmount, 0))},
            без суммы — {num(rows.reduce((s, r) => s + r.g.noAmount, 0))}.
          </Note>
        </div>
      )}
    </Card>
  )
}
