'use client'

// Аналитика покупок: сколько коробок продано, откуда и по какой цене, а
// также остаток на складе и доля повторных покупателей. Данные — из
// таблицы orders (её же видит страница «Заказы»); остаток товара
// редактируется в «WhatsApp: шаблоны и доставка» → «Товароучёт», здесь
// только показывается, чтобы не дублировать форму.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getWhatsappSettings } from '@/actions/whatsapp-settings'

const LOOKBACK_DAYS = 90

type OrderRow = {
  id: string
  customer_phone: string | null
  quantity: number | null
  total_amount: number | null
  currency: string
  city: string | null
  status: string
  external_key: string | null
  created_at: string
}

type Analytics = {
  ordersCount: number
  boxesCount: number
  revenue: number
  avgCheck: number
  bySource: { label: string; count: number }[]
  byCity: { label: string; count: number }[]
  byPrice: { label: string; count: number }[]
  uniqueCustomers: number
  repeatCustomers: number
  repeatRate: number
}

function sourceLabel(externalKey: string | null): string {
  if (!externalKey) return 'Не указано'
  const prefix = externalKey.split(':')[0]
  if (prefix === 'telegram') return 'Telegram'
  if (prefix === 'greenapi') return 'WhatsApp'
  if (prefix === 'amocrm') return 'WhatsApp (amoCRM)'
  return prefix || 'Другое'
}

function priceLabel(amount: number | null, quantity: number | null): string {
  if (amount === null || !quantity) return 'Не указана'
  const perBox = Math.round(amount / quantity)
  if (perBox >= 1450) return '1490 сом (без скидки)'
  if (perBox >= 1250) return '1290 сом (13%)'
  if (perBox >= 1150) return '1190 сом (20%)'
  return `${perBox.toLocaleString('ru-RU')} сом`
}

function computeAnalytics(orders: OrderRow[]): Analytics {
  const active = orders.filter((o) => o.status !== 'cancelled')

  const bySourceMap = new Map<string, number>()
  const byCityMap = new Map<string, number>()
  const byPriceMap = new Map<string, number>()
  const customerOrders = new Map<string, number>()

  let boxesCount = 0
  let revenue = 0
  let revenueOrders = 0

  for (const order of active) {
    boxesCount += order.quantity ?? 0
    if (order.total_amount !== null) {
      revenue += Number(order.total_amount)
      revenueOrders++
    }
    const source = sourceLabel(order.external_key)
    bySourceMap.set(source, (bySourceMap.get(source) ?? 0) + 1)

    const city = order.city?.trim() || 'Не указан'
    byCityMap.set(city, (byCityMap.get(city) ?? 0) + 1)

    const price = priceLabel(order.total_amount, order.quantity)
    byPriceMap.set(price, (byPriceMap.get(price) ?? 0) + 1)

    const phone = order.customer_phone?.replace(/\D/g, '')
    if (phone) customerOrders.set(phone, (customerOrders.get(phone) ?? 0) + 1)
  }

  const uniqueCustomers = customerOrders.size
  const repeatCustomers = [...customerOrders.values()].filter((count) => count > 1).length

  const toSorted = (map: Map<string, number>) =>
    [...map.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)

  return {
    ordersCount: active.length,
    boxesCount,
    revenue,
    avgCheck: revenueOrders ? Math.round(revenue / revenueOrders) : 0,
    bySource: toSorted(bySourceMap),
    byCity: toSorted(byCityMap),
    byPrice: toSorted(byPriceMap),
    uniqueCustomers,
    repeatCustomers,
    repeatRate: uniqueCustomers ? Math.round((repeatCustomers / uniqueCustomers) * 100) : 0,
  }
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-5">
      <h2 className="font-semibold text-sm mb-4" style={{ color: '#1b1517' }}>{title}</h2>
      {children}
    </div>
  )
}

function Bars({ items, max }: { items: { label: string; count: number }[]; max: number }) {
  if (items.length === 0) return <p className="text-sm" style={{ color: '#6b6063' }}>Нет данных</p>
  return (
    <div className="flex flex-col gap-2.5">
      {items.map((item) => (
        <div key={item.label}>
          <div className="flex justify-between text-xs mb-1">
            <span style={{ color: '#1b1517' }}>{item.label}</span>
            <span style={{ color: '#6b6063' }}>{item.count}</span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: '#fdfbfb' }}>
            <div className="h-full rounded-full" style={{ width: `${(item.count / max) * 100}%`, backgroundColor: '#5115a4' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function PurchaseAnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null)
  const [stock, setStock] = useState<number | null | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString()

    Promise.all([
      supabase
        .from('orders')
        .select('id, customer_phone, quantity, total_amount, currency, city, status, external_key, created_at')
        .is('deleted_at', null)
        .gte('created_at', since)
        .limit(5000),
      getWhatsappSettings(),
    ])
      .then(([ordersRes, settings]) => {
        if (ordersRes.error) throw ordersRes.error
        setData(computeAnalytics((ordersRes.data ?? []) as OrderRow[]))
        setStock(settings?.stock.quantity ?? null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ошибка загрузки'))
      .finally(() => setLoading(false))
  }, [])

  const maxSource = useMemo(() => Math.max(...(data?.bySource.map((s) => s.count) ?? [1]), 1), [data])
  const maxCity = useMemo(() => Math.max(...(data?.byCity.map((s) => s.count) ?? [1]), 1), [data])
  const maxPrice = useMemo(() => Math.max(...(data?.byPrice.map((s) => s.count) ?? [1]), 1), [data])

  if (loading) return <p className="p-8 text-sm" style={{ color: '#6b6063' }}>Загрузка аналитики...</p>
  if (error) return <p className="p-8 text-sm" style={{ color: '#b91c1c' }}>Ошибка: {error}</p>
  if (!data) return <p className="p-8 text-sm" style={{ color: '#6b6063' }}>Нет данных</p>

  const statCards = [
    { label: `Заказов за ${LOOKBACK_DAYS} дн.`, value: data.ordersCount, color: '#5115a4' },
    { label: 'Коробок продано', value: data.boxesCount, color: '#5115a4' },
    { label: 'Выручка', value: `${data.revenue.toLocaleString('ru-RU')} сом`, color: '#047857' },
    { label: 'Средний чек', value: data.avgCheck ? `${data.avgCheck.toLocaleString('ru-RU')} сом` : '—', color: '#5115a4' },
    { label: 'Уникальных клиентов', value: data.uniqueCustomers, color: '#5115a4' },
    { label: 'Повторных клиентов', value: `${data.repeatCustomers} (${data.repeatRate}%)`, color: '#b45309' },
    {
      label: 'Остаток на складе',
      value: stock === null || stock === undefined ? 'не включён' : stock,
      color: stock !== null && stock !== undefined && stock <= 5 ? '#b91c1c' : '#047857',
    },
  ]

  return (
    <div className="p-4 md:p-8 flex flex-col gap-5">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        {statCards.map((s) => (
          <div key={s.label} className="rounded-2xl bg-white px-4 py-3.5">
            <div className="text-xl font-bold" style={{ color: s.color }}>
              {typeof s.value === 'number' ? s.value.toLocaleString('ru-RU') : s.value}
            </div>
            <div className="text-xs mt-0.5" style={{ color: '#6b6063' }}>{s.label}</div>
          </div>
        ))}
      </div>
      {(stock === null || stock === undefined) && (
        <p className="text-xs" style={{ color: '#6b6063' }}>
          Товароучёт выключен (остаток не задан) — включить и задать количество можно в «WhatsApp: шаблоны и доставка» → «Товароучёт».
        </p>
      )}

      <div className="grid gap-5 md:grid-cols-3">
        <Card title="Откуда заказы">
          <Bars items={data.bySource} max={maxSource} />
        </Card>
        <Card title="По городам">
          <Bars items={data.byCity} max={maxCity} />
        </Card>
        <Card title="По цене за коробку">
          <Bars items={data.byPrice} max={maxPrice} />
        </Card>
      </div>
    </div>
  )
}
