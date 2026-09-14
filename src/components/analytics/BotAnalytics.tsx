'use client'

// Старая версия ходила через /api/backend → BOT_BACKEND_API_URL — бэкенд из
// шаблона-форка DemiResults, которого у SmileKit никогда не было (переменная
// не задана → ECONNREFUSED → «нет данных» с первого дня, не сбой на днях).
// У реального бота (aiogram, smilekit_bot/api.py) нет такой ручки и нет самой
// модели данных (approve/reject лидов) — строим аналитику из того, что
// реально есть: amocrm_messages (переписка) и orders (заказы).

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

const LOOKBACK_DAYS = 30
const BISHKEK_TZ = 'Asia/Bishkek'

type MessageRow = { chat_id: string; sender: string; text: string; created_at: string }
type OrderRow = { total_amount: number | null; currency: string | null }

type Analytics = {
  conversations: number
  totalClient: number
  totalBot: number
  totalOperator: number
  takeoverChats: number
  ordersCount: number
  ordersSum: number
  daily: { date: string; client: number; bot: number }[]
  hourly: { hour: number; count: number }[]
  topics: { label: string; count: number }[]
}

const TOPIC_PATTERNS: [string, RegExp][] = [
  ['Цена', /цена|наркы|сколько стоит|стоимост|канча/i],
  ['Доставка', /достав|привез|отправ|жеткир/i],
  ['Оплата', /оплат|перевод|\bqr\b|карт/i],
  ['Скидка', /скидк|акци/i],
  ['Сомнения / не мошенники', /мошенник|обман|развод|скам|доверя/i],
  ['Жалобы', /жалоб|верните|разочарован|ужасн|не помог/i],
  ['Сотрудничество / опт', /сотрудничеств|\bопт\b|дилер|партн[её]р|реселлер/i],
  ['Город / адрес', /город|адрес|бишкек|\bош\b|токмок|каракол/i],
]

function bishkekDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BISHKEK_TZ }).format(new Date(iso))
}
function bishkekHour(iso: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: BISHKEK_TZ, hour: '2-digit', hour12: false }).format(new Date(iso)))
}

function computeAnalytics(messages: MessageRow[], orders: OrderRow[]): Analytics {
  const conversationSet = new Set<string>()
  const takeoverSet = new Set<string>()
  let totalClient = 0, totalBot = 0, totalOperator = 0

  const dailyMap = new Map<string, { client: number; bot: number }>()
  const hourlyMap = new Map<number, number>()
  for (let h = 0; h < 24; h++) hourlyMap.set(h, 0)
  const topicCounts = new Map<string, number>(TOPIC_PATTERNS.map(([label]) => [label, 0]))

  for (const m of messages) {
    conversationSet.add(m.chat_id)
    if (m.sender === 'operator') takeoverSet.add(m.chat_id)
    if (m.sender === 'client') totalClient++
    else if (m.sender === 'bot') totalBot++
    else if (m.sender === 'operator') totalOperator++

    const day = bishkekDate(m.created_at)
    const entry = dailyMap.get(day) ?? { client: 0, bot: 0 }
    if (m.sender === 'client') entry.client++
    if (m.sender === 'bot') entry.bot++
    dailyMap.set(day, entry)

    if (m.sender === 'client') {
      hourlyMap.set(bishkekHour(m.created_at), (hourlyMap.get(bishkekHour(m.created_at)) ?? 0) + 1)
    }
  }

  // Темы считаем по последним 2000 сообщениям клиента — на весь массив
  // регэкспы гонять незачем, а порядок величины не меняется.
  const clientTexts = messages.filter((m) => m.sender === 'client')
  for (const m of clientTexts) {
    for (const [label, pattern] of TOPIC_PATTERNS) {
      if (pattern.test(m.text ?? '')) {
        topicCounts.set(label, (topicCounts.get(label) ?? 0) + 1)
      }
    }
  }

  const daily = [...dailyMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, client: v.client, bot: v.bot }))

  const ordersSum = orders.reduce((sum, o) => sum + Number(o.total_amount ?? 0), 0)

  return {
    conversations: conversationSet.size,
    totalClient,
    totalBot,
    totalOperator,
    takeoverChats: takeoverSet.size,
    ordersCount: orders.length,
    ordersSum,
    daily,
    hourly: [...hourlyMap.entries()].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, count })),
    topics: [...topicCounts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
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

export default function BotAnalytics() {
  const [data, setData] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString()

    Promise.all([
      supabase
        .from('amocrm_messages')
        .select('chat_id, sender, text, created_at')
        .gte('created_at', since)
        .not('chat_id', 'like', '%@g.us') // групповой чат доставки — не переписка с клиентом
        .limit(20000),
      supabase
        .from('orders')
        .select('total_amount, currency')
        .gte('created_at', since),
    ])
      .then(([messagesRes, ordersRes]) => {
        if (messagesRes.error) throw messagesRes.error
        if (ordersRes.error) throw ordersRes.error
        setData(computeAnalytics(messagesRes.data as MessageRow[], (ordersRes.data ?? []) as OrderRow[]))
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ошибка загрузки'))
      .finally(() => setLoading(false))
  }, [])

  const maxHour = useMemo(() => Math.max(...(data?.hourly.map((h) => h.count) ?? [1]), 1), [data])
  const maxDaily = useMemo(
    () => Math.max(...(data?.daily.flatMap((d) => [d.client, d.bot]) ?? [1]), 1),
    [data]
  )
  const maxTopic = useMemo(() => Math.max(...(data?.topics.map((t) => t.count) ?? [1]), 1), [data])

  if (loading) return <p className="p-8 text-sm" style={{ color: '#6b6063' }}>Загрузка аналитики...</p>
  if (error) return <p className="p-8 text-sm" style={{ color: '#b91c1c' }}>Ошибка: {error}</p>
  if (!data) return <p className="p-8 text-sm" style={{ color: '#6b6063' }}>Нет данных</p>

  const takeoverRate = data.conversations ? Math.round((data.takeoverChats / data.conversations) * 100) : 0
  const conversionRate = data.conversations ? Math.round((data.ordersCount / data.conversations) * 100) : 0

  const statCards = [
    { label: `Диалогов за ${LOOKBACK_DAYS} дн.`, value: data.conversations, color: '#5115a4' },
    { label: 'Сообщений клиентов', value: data.totalClient, color: '#5115a4' },
    { label: 'Ответов бота', value: data.totalBot, color: '#047857' },
    { label: 'Ответов менеджера', value: data.totalOperator, color: '#b45309' },
    { label: 'Перехвачено менеджером', value: `${data.takeoverChats} (${takeoverRate}%)`, color: '#b91c1c' },
    { label: 'Заказов', value: data.ordersCount, color: '#5115a4' },
    { label: 'Конверсия в заказ', value: `${conversionRate}%`, color: '#047857' },
    { label: 'Сумма заказов', value: `${data.ordersSum.toLocaleString('ru-RU')} сом`, color: '#5115a4' },
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

      <Card title={`Сообщения по дням (последние ${LOOKBACK_DAYS} дн.)`}>
        <div className="flex items-end gap-1" style={{ height: 140 }}>
          {data.daily.map((d) => (
            <div key={d.date} className="flex-1 flex flex-col items-center justify-end h-full gap-0.5" title={`${d.date}: клиент ${d.client}, бот ${d.bot}`}>
              <div className="w-full flex flex-col justify-end gap-0.5" style={{ height: '100%' }}>
                <div className="w-full rounded-t" style={{ height: `${Math.max((d.bot / maxDaily) * 100, d.bot ? 2 : 0)}%`, backgroundColor: '#047857' }} />
                <div className="w-full rounded-t" style={{ height: `${Math.max((d.client / maxDaily) * 100, d.client ? 2 : 0)}%`, backgroundColor: '#5115a4' }} />
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-4 mt-3 text-xs" style={{ color: '#6b6063' }}>
          <span><span className="inline-block w-2.5 h-2.5 rounded-sm mr-1" style={{ backgroundColor: '#5115a4' }} />клиент</span>
          <span><span className="inline-block w-2.5 h-2.5 rounded-sm mr-1" style={{ backgroundColor: '#047857' }} />бот</span>
        </div>
      </Card>

      <div className="grid gap-5 md:grid-cols-2">
        <Card title="Активность клиентов по часам (Бишкек)">
          <div className="flex items-end gap-0.5" style={{ height: 120 }}>
            {data.hourly.map((h) => (
              <div key={h.hour} className="flex-1 flex flex-col items-center justify-end h-full" title={`${h.hour}:00 — ${h.count} сообщ.`}>
                <div className="w-full rounded-t" style={{
                  height: `${Math.max((h.count / maxHour) * 100, 2)}%`,
                  backgroundColor: '#5115a4', opacity: h.count > 0 ? 1 : 0.15,
                }} />
                {h.hour % 6 === 0 && <span className="text-[9px] mt-1" style={{ color: '#7d7174' }}>{h.hour}</span>}
              </div>
            ))}
          </div>
        </Card>

        <Card title="О чём спрашивают клиенты">
          {data.topics.every((t) => t.count === 0) && <p className="text-sm" style={{ color: '#6b6063' }}>Нет данных</p>}
          <div className="flex flex-col gap-2.5">
            {data.topics.filter((t) => t.count > 0).map((t) => (
              <div key={t.label}>
                <div className="flex justify-between text-xs mb-1">
                  <span style={{ color: '#1b1517' }}>{t.label}</span>
                  <span style={{ color: '#6b6063' }}>{t.count}</span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: '#fdfbfb' }}>
                  <div className="h-full rounded-full" style={{ width: `${(t.count / maxTopic) * 100}%`, backgroundColor: '#5115a4' }} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
