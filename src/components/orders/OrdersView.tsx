'use client'

// Список заказов: фильтры, итоги, карточка заказа.
// Заказы приходят из Telegram-бота, поэтому список живой — новая строка
// должна появляться без перезагрузки страницы.

import { useEffect, useMemo, useState } from 'react'
import { Package, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import EmptyState from '@/components/common/EmptyState'
import OrderDetail from './OrderDetail'
import {
  ORDER_PERIODS,
  ORDER_STATUS,
  ORDER_STATUS_ORDER,
  formatOrderDate,
  formatOrderMoney,
  periodStart,
  type OrderPeriod,
} from './order-config'
import type { DealEmployee, Order, OrderDealRef, OrderStatus } from '@/types'

type StatusFilter = OrderStatus | 'all'

export default function OrdersView({
  initialOrders,
  employees,
  deals,
  initialOrderId,
}: {
  initialOrders: Order[]
  employees: DealEmployee[]
  deals: Record<string, OrderDealRef>
  initialOrderId: string | null
}) {
  const [orders, setOrders] = useState(initialOrders)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [city, setCity] = useState('all')
  const [period, setPeriod] = useState<OrderPeriod>('all')
  const [openId, setOpenId] = useState<string | null>(initialOrderId)

  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const channel = supabase
      .channel('orders-list')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders' },
        (payload) => {
          const row = payload.new as Order | undefined
          if (!row?.id) return
          setOrders(prev =>
            prev.some(o => o.id === row.id)
              ? prev.map(o => (o.id === row.id ? row : o))
              : [row, ...prev]
          )
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [supabase])

  const cities = useMemo(() => {
    const set = new Set<string>()
    for (const order of orders) if (order.city) set.add(order.city)
    return [...set].sort((a, b) => a.localeCompare(b, 'ru'))
  }, [orders])

  const visible = useMemo(() => {
    const from = periodStart(period)
    return orders.filter(order => {
      if (status !== 'all' && order.status !== status) return false
      if (city !== 'all' && order.city !== city) return false
      if (from !== null && new Date(order.created_at).getTime() < from) return false
      return true
    })
  }, [orders, status, city, period])

  // Итоги считаем по отфильтрованному списку: заголовок должен отвечать
  // на тот же вопрос, что и таблица под ним.
  const totals = useMemo(() => {
    const sums = new Map<string, number>()
    let boxes = 0
    let unknownAmount = 0
    for (const order of visible) {
      if (order.quantity !== null) boxes += order.quantity
      if (order.total_amount === null) {
        unknownAmount += 1
        continue
      }
      sums.set(order.currency, (sums.get(order.currency) ?? 0) + Number(order.total_amount))
    }
    return { sums: [...sums.entries()], boxes, unknownAmount, count: visible.length }
  }, [visible])

  const openOrder = orders.find(o => o.id === openId) ?? null

  return (
    <div className="flex flex-col gap-5 p-4 md:p-8">
      <div className="flex items-start gap-3">
        <div
          className="flex size-11 shrink-0 items-center justify-center rounded-2xl"
          style={{ background: 'var(--brand)' }}
        >
          <Package size={22} color="#fff" />
        </div>
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--ink)' }}>Заказы</h1>
          <p className="mt-0.5 text-sm" style={{ color: 'var(--ink-3)' }}>
            Заказы, оформленные клиентами в Telegram- и WhatsApp-боте. Пустые поля бот не выдумывает —
            их уточняет менеджер.
          </p>
        </div>
      </div>

      {/* Итоги */}
      <div className="grid gap-3 sm:grid-cols-3">
        <TotalCard label="Заказов" value={String(totals.count)} />
        <TotalCard
          label="Коробок"
          value={totals.boxes > 0 ? String(totals.boxes) : '—'}
          hint={totals.boxes > 0 ? undefined : 'количество ещё не уточнено'}
        />
        <TotalCard
          label="Сумма"
          value={
            totals.sums.length
              ? totals.sums.map(([cur, sum]) => `${sum.toLocaleString('ru-RU')} ${cur}`).join(' · ')
              : '—'
          }
          hint={
            totals.unknownAmount > 0
              ? `без суммы: ${totals.unknownAmount}`
              : undefined
          }
        />
      </div>

      {/* Фильтры */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterGroup
          options={[
            { value: 'all', label: 'Все' },
            ...ORDER_STATUS_ORDER.map(s => ({ value: s, label: ORDER_STATUS[s].label })),
          ]}
          value={status}
          onChange={v => setStatus(v as StatusFilter)}
        />
        <span className="mx-1 h-5 w-px" style={{ background: 'var(--line)' }} />
        <FilterGroup
          options={ORDER_PERIODS.map(p => ({ value: p.value, label: p.label }))}
          value={period}
          onChange={v => setPeriod(v as OrderPeriod)}
        />
        {cities.length > 0 && (
          <>
            <span className="mx-1 h-5 w-px" style={{ background: 'var(--line)' }} />
            <select
              value={city}
              onChange={e => setCity(e.target.value)}
              className="min-h-9 rounded-xl px-3 py-1.5 text-base outline-none md:min-h-0 md:text-xs"
              style={{
                border: '1px solid var(--line)',
                background: 'var(--surface)',
                color: 'var(--ink-2)',
              }}
            >
              <option value="all">Все города</option>
              {cities.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </>
        )}
      </div>

      {/* Список */}
      {visible.length === 0 ? (
        <EmptyState
          icon={orders.length === 0 ? Package : Search}
          title={orders.length === 0 ? 'Заказов пока нет' : 'Под фильтры ничего не подошло'}
          hint={
            orders.length === 0
              ? 'Первый заказ появится здесь сам, как только клиент оформит его у бота в Telegram.'
              : 'Снимите часть условий — статус, период или город.'
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map(order => {
            const meta = ORDER_STATUS[order.status]
            const who =
              order.customer_name ||
              order.customer_username ||
              order.customer_phone ||
              'Клиент без имени'
            return (
              <button
                key={order.id}
                onClick={() => setOpenId(order.id)}
                className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-colors"
                style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}
              >
                <span
                  className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  style={{ background: meta.bg, color: meta.color }}
                >
                  {meta.label}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                    {who}
                  </span>
                  <span className="block truncate text-xs" style={{ color: 'var(--ink-3)' }}>
                    {[order.city, order.customer_phone].filter(Boolean).join(' · ') || 'город и телефон не указаны'}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>
                    {formatOrderMoney(
                      order.total_amount === null ? null : Number(order.total_amount),
                      order.currency
                    )}
                  </span>
                  <span className="block text-xs tabular-nums" style={{ color: 'var(--ink-3)' }}>
                    {order.quantity !== null ? `${order.quantity} кор. · ` : ''}
                    {formatOrderDate(order.created_at)}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}

      {openOrder && (
        <OrderDetail
          order={openOrder}
          employees={employees}
          deal={openOrder.deal_id ? deals[openOrder.deal_id] ?? null : null}
          onClose={() => setOpenId(null)}
          onPatch={patch =>
            setOrders(prev => prev.map(o => (o.id === patch.id ? { ...o, ...patch } : o)))
          }
        />
      )}
    </div>
  )
}

function TotalCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      className="rounded-2xl px-4 py-3.5"
      style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}
    >
      <p className="text-xs" style={{ color: 'var(--ink-3)' }}>{label}</p>
      <p className="mt-1 text-lg font-bold tabular-nums" style={{ color: 'var(--ink)' }}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px]" style={{ color: 'var(--ink-3)' }}>{hint}</p>}
    </div>
  )
}

function FilterGroup({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(option => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            className="min-h-9 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors md:min-h-0"
            style={{
              background: active ? 'var(--brand)' : 'var(--surface)',
              color: active ? '#ffffff' : 'var(--ink-2)',
              border: `1px solid ${active ? 'var(--brand)' : 'var(--line)'}`,
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
