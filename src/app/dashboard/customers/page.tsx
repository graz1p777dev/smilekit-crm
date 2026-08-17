'use client'

// Клиенты, агрегированные по номеру телефона (orders.customer_phone):
// сколько раз покупал, на какую сумму, повторный ли — и написать ему
// прямо отсюда (sendCustomerMessage, тот же канал, что и остальной бот).

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { MessageCircle, RotateCw, Search, Send, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { sendCustomerMessage } from '@/actions/customers'

type OrderRow = {
  id: string
  customer_name: string | null
  customer_phone: string | null
  quantity: number | null
  total_amount: number | null
  currency: string
  city: string | null
  status: string
  created_at: string
}

type Customer = {
  phone: string
  name: string
  ordersCount: number
  totalSpent: number
  lastCity: string | null
  firstOrderAt: string
  lastOrderAt: string
  orders: OrderRow[]
}

function buildCustomers(orders: OrderRow[]): Customer[] {
  const byPhone = new Map<string, OrderRow[]>()
  for (const order of orders) {
    const phone = order.customer_phone?.replace(/\D/g, '')
    if (!phone) continue
    if (!byPhone.has(phone)) byPhone.set(phone, [])
    byPhone.get(phone)!.push(order)
  }
  const customers: Customer[] = []
  for (const [phone, list] of byPhone) {
    const sorted = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at))
    const active = sorted.filter((o) => o.status !== 'cancelled')
    customers.push({
      phone,
      name: sorted.find((o) => o.customer_name)?.customer_name || 'Без имени',
      ordersCount: active.length,
      totalSpent: active.reduce((sum, o) => sum + Number(o.total_amount ?? 0), 0),
      lastCity: [...sorted].reverse().find((o) => o.city)?.city ?? null,
      firstOrderAt: sorted[0].created_at,
      lastOrderAt: sorted[sorted.length - 1].created_at,
      orders: sorted,
    })
  }
  return customers.sort((a, b) => b.lastOrderAt.localeCompare(a.lastOrderAt))
}

export default function CustomersPage() {
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [openPhone, setOpenPhone] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    Promise.resolve(
      supabase
        .from('orders')
        .select('id, customer_name, customer_phone, quantity, total_amount, currency, city, status, created_at')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(5000)
    )
      .then(({ data }) => setOrders((data ?? []) as OrderRow[]))
      .finally(() => setLoading(false))
  }, [])

  const customers = useMemo(() => buildCustomers(orders), [orders])
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return customers
    return customers.filter((c) => c.phone.includes(q) || c.name.toLowerCase().includes(q))
  }, [customers, search])

  const openCustomer = customers.find((c) => c.phone === openPhone) ?? null

  async function send() {
    if (!openCustomer || !message.trim()) return
    setSending(true)
    try {
      const result = await sendCustomerMessage(openCustomer.phone, message)
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success('Отправлено')
      setMessage('')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="p-4 md:p-8 flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold" style={{ color: '#1b1517' }}>Клиенты</h1>
          <p className="text-sm mt-0.5" style={{ color: '#6b6063' }}>
            {customers.length} клиентов · {customers.filter((c) => c.ordersCount > 1).length} с повторной покупкой
          </p>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#9a93a8' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по имени или номеру"
            className="rounded-xl pl-8 pr-3 py-2 text-sm outline-none"
            style={{ border: '1px solid #ece5e5', background: '#fff', minWidth: 220 }}
          />
        </div>
      </div>

      {loading ? (
        <p className="text-sm" style={{ color: '#6b6063' }}>Загрузка...</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm" style={{ color: '#6b6063' }}>Ничего не найдено</p>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white" style={{ border: '1px solid #ece5e5' }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-left" style={{ color: '#6b6063', background: '#faf8f7' }}>
                <th className="px-4 py-3 font-medium">Клиент</th>
                <th className="px-4 py-3 font-medium">Телефон</th>
                <th className="px-4 py-3 font-medium text-right">Заказов</th>
                <th className="px-4 py-3 font-medium text-right">Сумма</th>
                <th className="px-4 py-3 font-medium">Город</th>
                <th className="px-4 py-3 font-medium">Последний заказ</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.phone} style={{ borderTop: '1px solid #f0eaea' }}>
                  <td className="px-4 py-3">
                    <span className="font-medium" style={{ color: '#1b1517' }}>{c.name}</span>
                    {c.ordersCount > 1 && (
                      <span
                        className="ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                        style={{ background: '#dcfce7', color: '#15803d' }}
                      >
                        повторный
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 tabular-nums" style={{ color: '#4e4560' }}>{c.phone}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{c.ordersCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">
                    {c.totalSpent > 0 ? `${c.totalSpent.toLocaleString('ru-RU')} сом` : '—'}
                  </td>
                  <td className="px-4 py-3" style={{ color: '#6b6063' }}>{c.lastCity || '—'}</td>
                  <td className="px-4 py-3 tabular-nums text-xs" style={{ color: '#6b6063' }}>
                    {new Date(c.lastOrderAt).toLocaleDateString('ru-RU')}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpenPhone(c.phone)}>
                      <MessageCircle size={13} />
                      Написать
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openCustomer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(23,16,42,0.35)' }}
          onClick={() => setOpenPhone(null)}
        >
          <div
            className="w-full rounded-2xl bg-white p-5 flex flex-col gap-4"
            style={{ maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-semibold" style={{ color: '#1b1517' }}>{openCustomer.name}</h2>
                <p className="text-xs" style={{ color: '#6b6063' }}>{openCustomer.phone}</p>
              </div>
              <button onClick={() => setOpenPhone(null)}><X size={18} color="#6b6063" /></button>
            </div>

            <div>
              <p className="text-xs font-medium mb-2" style={{ color: '#6b6063' }}>История заказов</p>
              <div className="flex flex-col gap-1.5">
                {openCustomer.orders.map((o) => (
                  <div key={o.id} className="flex items-center justify-between text-xs rounded-lg px-3 py-2" style={{ background: '#fdfbfb' }}>
                    <span style={{ color: '#4e4560' }}>{new Date(o.created_at).toLocaleDateString('ru-RU')}</span>
                    <span style={{ color: '#1b1517' }}>{o.quantity ?? '—'} кор.</span>
                    <span style={{ color: '#1b1517' }}>{o.total_amount ? `${Number(o.total_amount).toLocaleString('ru-RU')} сом` : '—'}</span>
                    <span style={{ color: '#6b6063' }}>{o.status}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium" style={{ color: '#6b6063' }}>Написать в WhatsApp</p>
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Текст сообщения…"
                className="min-h-[70px] resize-none"
                disabled={sending}
              />
              <Button onClick={() => void send()} disabled={sending || !message.trim()} className="self-end gap-1.5">
                {sending ? <RotateCw size={14} className="animate-spin" /> : <Send size={14} />}
                Отправить
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
