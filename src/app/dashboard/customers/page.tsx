'use client'

// Все клиенты CRM, а не только те, кто дошёл до заказа. Список строится из
// двух источников сразу:
//   deals  — каждый, кто написал в любой канал (бот заводит сделку сам),
//   orders — что и на какую сумму он купил.
// Раньше страница читала только orders, и клиент, который поговорил с
// ботом, но ничего не заказал, в CRM вообще не появлялся.
// Склеиваем по телефону (по последним 9 цифрам — формат номера у нас
// разный), а телеграм-клиентов без номера — по нику.

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { MessageCircle, RotateCw, Search, Send, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { sendCustomerMessage } from '@/actions/customers'
import { getClientProfile, type ClientProfile } from '@/actions/analytics'
import { CLIENT_TYPE_LABELS, CLIENT_TYPE_SHORT, formatDuration } from '@/lib/analytics/client-types'
import { ServedGroupsView } from '@/components/deals/ServedBy'

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

type DealRow = {
  id: string
  customer_name: string | null
  customer_phone: string | null
  customer_username: string | null
  city: string | null
  source: string
  created_at: string
}

type Customer = {
  key: string
  phone: string
  username: string | null
  name: string
  source: string
  ordersCount: number
  totalSpent: number
  lastCity: string | null
  lastActivityAt: string
  orders: OrderRow[]
}

const SOURCE_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  amocrm: 'WhatsApp',
  instagram: 'Instagram',
  site: 'Витрина',
  manual: 'Вручную',
}

type Filter = 'all' | 'buyers' | 'leads'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'buyers', label: 'С покупками' },
  { key: 'leads', label: 'Без покупок' },
]

const digits = (value: string | null | undefined) => String(value ?? '').replace(/\D/g, '')
/** Ключ склейки: номера лежат как 996…, 0…, +996… — сравниваем по хвосту. */
const phoneKey = (value: string | null | undefined) => {
  const only = digits(value)
  return only ? only.slice(-9) : ''
}

function buildCustomers(orders: OrderRow[], deals: DealRow[]): Customer[] {
  const byKey = new Map<string, Customer>()

  const upsert = (key: string, seed: Omit<Customer, 'key' | 'orders' | 'ordersCount' | 'totalSpent'>) => {
    const existing = byKey.get(key)
    if (!existing) {
      const created: Customer = { key, ...seed, ordersCount: 0, totalSpent: 0, orders: [] }
      byKey.set(key, created)
      return created
    }
    if (existing.name === 'Без имени' && seed.name !== 'Без имени') existing.name = seed.name
    if (!existing.phone) existing.phone = seed.phone
    if (!existing.username) existing.username = seed.username
    if (seed.lastCity) existing.lastCity = seed.lastCity
    if (seed.lastActivityAt > existing.lastActivityAt) existing.lastActivityAt = seed.lastActivityAt
    return existing
  }

  // Сначала сделки — они дают полный список тех, кто вообще писал.
  for (const deal of deals) {
    const phone = phoneKey(deal.customer_phone)
    const username = deal.customer_username?.replace(/^@/, '').trim() || null
    const key = phone ? `p:${phone}` : username ? `u:${username.toLowerCase()}` : `d:${deal.id}`
    upsert(key, {
      phone: digits(deal.customer_phone),
      username,
      name: deal.customer_name?.trim() || 'Без имени',
      source: SOURCE_LABELS[deal.source] ?? deal.source,
      lastCity: deal.city,
      lastActivityAt: deal.created_at,
    })
  }

  for (const order of orders) {
    const phone = phoneKey(order.customer_phone)
    // Заказ без телефона склеить не с чем — показываем отдельной строкой.
    const key = phone ? `p:${phone}` : `o:${order.id}`
    const customer = upsert(key, {
      phone: digits(order.customer_phone),
      username: null,
      name: order.customer_name?.trim() || 'Без имени',
      source: 'Заказ',
      lastCity: order.city,
      lastActivityAt: order.created_at,
    })
    customer.orders.push(order)
    if (order.status !== 'cancelled') {
      customer.ordersCount++
      customer.totalSpent += Number(order.total_amount ?? 0)
    }
  }

  for (const customer of byKey.values()) {
    customer.orders.sort((a, b) => a.created_at.localeCompare(b.created_at))
  }
  return [...byKey.values()].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
}

/** PostgREST режет выборку до 1000 строк — читаем постранично. */
async function fetchAll<T>(
  supabase: ReturnType<typeof createClient>,
  table: string,
  select: string
): Promise<T[]> {
  const PAGE_SIZE = 1000
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return rows
}

export default function CustomersPage() {
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [deals, setDeals] = useState<DealRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    Promise.all([
      fetchAll<OrderRow>(
        supabase, 'orders',
        'id, customer_name, customer_phone, quantity, total_amount, currency, city, status, created_at'
      ),
      // Сделок 12+ тыс.: постранично это 13 последовательных запросов с
      // проверкой RLS по всей таблице на каждом. deals_list_json (миграция
      // 066) отдаёт те же колонки и порядок одним ответом.
      supabase.rpc('deals_list_json', { p_compact: true }).then(({ data, error }) => {
        if (error) throw new Error(error.message)
        return (data ?? []) as DealRow[]
      }),
    ])
      .then(([orderRows, dealRows]) => {
        setOrders(orderRows)
        setDeals(dealRows)
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Не удалось загрузить клиентов')
      })
      .finally(() => setLoading(false))
  }, [])

  const customers = useMemo(() => buildCustomers(orders, deals), [orders, deals])
  const buyers = useMemo(() => customers.filter((c) => c.ordersCount > 0), [customers])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return customers.filter((c) => {
      if (filter === 'buyers' && c.ordersCount === 0) return false
      if (filter === 'leads' && c.ordersCount > 0) return false
      if (!q) return true
      return (
        c.phone.includes(q) ||
        c.name.toLowerCase().includes(q) ||
        (c.username?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [customers, search, filter])

  const openCustomer = customers.find((c) => c.key === openKey) ?? null

  // Тип клиента и «кто обслуживал» — по переписке и сменам, считает сервер.
  const [profile, setProfile] = useState<{ key: string; data: ClientProfile | null } | null>(null)
  const openPhone = openCustomer?.phone ?? ''
  useEffect(() => {
    if (!openKey || openPhone.length < 9) return
    let alive = true
    getClientProfile(openPhone)
      .then((data) => { if (alive) setProfile({ key: openKey, data }) })
      .catch(() => { if (alive) setProfile({ key: openKey, data: null }) })
    return () => { alive = false }
  }, [openKey, openPhone])
  const openProfile = profile && profile.key === openKey ? profile : null

  async function send() {
    if (!openCustomer || !openCustomer.phone || !message.trim()) return
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold" style={{ color: '#1b1517' }}>Клиенты</h1>
          <p className="text-sm mt-0.5" style={{ color: '#6b6063' }}>
            {customers.length} всего · {buyers.length} покупали ·{' '}
            {customers.length - buyers.length} пока без покупок ·{' '}
            {buyers.filter((c) => c.ordersCount > 1).length} с повторной покупкой
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 rounded-xl p-1" style={{ background: '#fdfbfb', border: '1px solid #ece5e5' }}>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
                style={filter === f.key ? { background: '#5115a4', color: '#fff' } : { color: '#6b6063' }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#9a93a8' }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по имени, номеру или нику"
              className="rounded-xl pl-8 pr-3 py-2 text-sm outline-none"
              style={{ border: '1px solid #ece5e5', background: '#fff', minWidth: 220 }}
            />
          </div>
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
                <th className="px-4 py-3 font-medium">Контакт</th>
                <th className="px-4 py-3 font-medium">Канал</th>
                <th className="px-4 py-3 font-medium text-right">Заказов</th>
                <th className="px-4 py-3 font-medium text-right">Сумма</th>
                <th className="px-4 py-3 font-medium">Город</th>
                <th className="px-4 py-3 font-medium">Последняя активность</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.key} style={{ borderTop: '1px solid #f0eaea' }}>
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
                    {c.ordersCount === 0 && (
                      <span
                        className="ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                        style={{ background: '#f1ebfa', color: '#5115a4' }}
                      >
                        лид
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 tabular-nums" style={{ color: '#4e4560' }}>
                    {c.phone || (c.username ? `@${c.username}` : '—')}
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: '#6b6063' }}>{c.source}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{c.ordersCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">
                    {c.totalSpent > 0 ? `${c.totalSpent.toLocaleString('ru-RU')} сом` : '—'}
                  </td>
                  <td className="px-4 py-3" style={{ color: '#6b6063' }}>{c.lastCity || '—'}</td>
                  <td className="px-4 py-3 tabular-nums text-xs" style={{ color: '#6b6063' }}>
                    {new Date(c.lastActivityAt).toLocaleDateString('ru-RU')}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpenKey(c.key)}>
                      <MessageCircle size={13} />
                      Открыть
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
          onClick={() => setOpenKey(null)}
        >
          <div
            className="w-full rounded-2xl bg-white p-5 flex flex-col gap-4"
            style={{ maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-semibold" style={{ color: '#1b1517' }}>{openCustomer.name}</h2>
                <p className="text-xs" style={{ color: '#6b6063' }}>
                  {openCustomer.phone || (openCustomer.username ? `@${openCustomer.username}` : 'Контакта нет')}
                  {' · '}{openCustomer.source}
                </p>
              </div>
              <button onClick={() => setOpenKey(null)}><X size={18} color="#6b6063" /></button>
            </div>

            {openCustomer.phone.length >= 9 && !(openProfile && openProfile.data === null) && (
              <div className="rounded-xl px-3 py-2.5 flex flex-col gap-2" style={{ background: '#fdfbfb', border: '1px solid #ece5e5' }}>
                {!openProfile?.data ? (
                  <p className="text-xs" style={{ color: '#6b6063' }}>Считаем по переписке…</p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                      <span style={{ color: '#6b6063' }}>Тип клиента</span>
                      <span className="font-semibold" style={{ color: '#5115a4' }}
                        title={openProfile.data.type ? CLIENT_TYPE_LABELS[openProfile.data.type].rule : 'не писал в WhatsApp'}>
                        {openProfile.data.type ? CLIENT_TYPE_SHORT[openProfile.data.type] : '—'}
                      </span>
                      <span style={{ color: '#6b6063' }}>Сообщений до покупки</span>
                      <span style={{ color: '#1b1517' }}>{openProfile.data.msgsBeforeOrder ?? '—'}</span>
                      <span style={{ color: '#6b6063' }}>Время до покупки</span>
                      <span style={{ color: '#1b1517' }}>
                        {openProfile.data.msToOrder === null ? '—' : formatDuration(openProfile.data.msToOrder)}
                      </span>
                      <span style={{ color: '#6b6063' }}>Покупки</span>
                      <span style={{ color: '#1b1517' }}>{openCustomer.ordersCount}</span>
                    </div>
                    <p className="text-[11px]" style={{ color: '#766d88' }}>
                      {openProfile.data.type
                        ? CLIENT_TYPE_LABELS[openProfile.data.type].rule
                        : 'В WhatsApp клиент не писал — тип не определяется.'}
                      {' '}Сообщения — клиент, человек и бот; до первого заказа после первого сообщения клиента.
                    </p>
                    <div>
                      <p className="text-xs font-medium mb-1" style={{ color: '#6b6063' }}>Кто обслуживал</p>
                      <ServedGroupsView hasChat={openProfile.data.hasChat} humanMessages={openProfile.data.humanMessages}
                        served={openProfile.data.served} />
                    </div>
                  </>
                )}
              </div>
            )}

            <div>
              <p className="text-xs font-medium mb-2" style={{ color: '#6b6063' }}>История заказов</p>
              {openCustomer.orders.length === 0 ? (
                <p className="text-xs" style={{ color: '#6b6063' }}>Ещё ничего не покупал</p>
              ) : (
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
              )}
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium" style={{ color: '#6b6063' }}>Написать в WhatsApp</p>
              {openCustomer.phone ? (
                <>
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
                </>
              ) : (
                <p className="text-xs" style={{ color: '#6b6063' }}>
                  Номера нет — написать можно только там, где клиент писал сам (Telegram, Instagram).
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
