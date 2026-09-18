'use client'

// Старая версия ходила через /api/backend → BOT_BACKEND_API_URL — бэкенд из
// шаблона-форка DemiResults, которого у SmileKit никогда не было (переменная
// не задана → ECONNREFUSED → «нет данных» с первого дня, не сбой на днях).
// У реального бота (aiogram, smilekit_bot/api.py) нет такой ручки и нет самой
// модели данных (approve/reject лидов) — строим аналитику из того, что
// реально есть: chat_messages (переписка) и orders (заказы).

import { useEffect, useState } from 'react'
import {
  BarChart3, Bot, Clock, Handshake, Headset, HelpCircle, MessageCircle, MessagesSquare, ShoppingBag, Target, Wallet,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import {
  Bars, Card, EmptyState, ErrorState, INK_2, INK_3, Kpi, KpiGrid, LINE, SERIES, TabBody, TabSkeleton, num,
} from './viz'

const LOOKBACK_DAYS = 30
const BISHKEK_TZ = 'Asia/Bishkek'

type MessageRow = { chat_id: string; sender: string; text: string; created_at: string }
type OrderRow = { total_amount: number | null; currency: string | null }

export type Analytics = {
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

export default function BotAnalytics() {
  const [data, setData] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString()

    Promise.all([
      supabase
        .from('chat_messages')
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

  if (loading) return <TabSkeleton text="Загрузка аналитики…" tiles={8} blocks={['chart', 'chart', 'bars']} />
  if (error) return <ErrorState text={error} />
  if (!data) return <div className="p-4 md:p-8"><EmptyState icon={Bot} text="Нет данных" /></div>
  return <BotView data={data} />
}

export function BotView({ data }: { data: Analytics }) {
  const maxHour = Math.max(...data.hourly.map((h) => h.count), 1)
  const maxDaily = Math.max(...data.daily.flatMap((d) => [d.client, d.bot]), 1)

  const takeoverRate = data.conversations ? Math.round((data.takeoverChats / data.conversations) * 100) : 0
  const conversionRate = data.conversations ? Math.round((data.ordersCount / data.conversations) * 100) : 0

  const topics = data.topics.filter((t) => t.count > 0)

  return (
    <TabBody>
      <KpiGrid>
        <Kpi hero icon={MessagesSquare} label={`Диалогов за ${LOOKBACK_DAYS} дн.`} value={num(data.conversations)} />
        <Kpi icon={MessageCircle} label="Сообщений клиентов" value={num(data.totalClient)} />
        <Kpi icon={Bot} label="Ответов бота" value={num(data.totalBot)} />
        <Kpi icon={Headset} label="Ответов менеджера" value={num(data.totalOperator)} />
        <Kpi icon={Handshake} label="Перехвачено менеджером" value={`${num(data.takeoverChats)} (${takeoverRate}%)`} />
        <Kpi icon={ShoppingBag} label="Заказов" value={num(data.ordersCount)} />
        <Kpi icon={Target} tone="good" label="Конверсия в заказ" value={`${conversionRate}%`} />
        <Kpi icon={Wallet} label="Сумма заказов" value={`${data.ordersSum.toLocaleString('ru-RU')} сом`} />
      </KpiGrid>

      <Card icon={BarChart3} title={`Сообщения по дням (последние ${LOOKBACK_DAYS} дн.)`}>
        {data.daily.length === 0 ? <EmptyState icon={MessagesSquare} text="Нет сообщений" /> : (
          <>
            <div className="flex items-end gap-[2px]" style={{ height: 140, borderBottom: `1px solid ${LINE}` }}>
              {data.daily.map((d) => (
                <div key={d.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={`${d.date}: клиент ${d.client}, бот ${d.bot}`}>
                  <div className="flex h-full w-full max-w-6 flex-col justify-end gap-[2px]">
                    <div className="w-full rounded-t-[4px]" style={{ height: `${Math.max((d.bot / maxDaily) * 100, d.bot ? 2 : 0)}%`, backgroundColor: SERIES[1] }} />
                    <div className="w-full" style={{ height: `${Math.max((d.client / maxDaily) * 100, d.client ? 2 : 0)}%`, backgroundColor: SERIES[0] }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-4 text-xs" style={{ color: INK_2 }}>
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ backgroundColor: SERIES[0] }} />клиент</span>
              <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ backgroundColor: SERIES[1] }} />бот</span>
            </div>
          </>
        )}
      </Card>

      <div className="grid items-start gap-4 md:grid-cols-2 md:gap-5">
        <Card icon={Clock} title="Активность клиентов по часам (Бишкек)">
          <div className="flex items-end gap-[2px]" style={{ height: 120, borderBottom: `1px solid ${LINE}` }}>
            {data.hourly.map((h) => (
              <div key={h.hour} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={`${h.hour}:00 — ${h.count} сообщ.`}>
                {h.count > 0 && (
                  <div className="w-full max-w-6 rounded-t-[4px]" style={{ height: `${Math.max((h.count / maxHour) * 100, 2)}%`, backgroundColor: SERIES[0] }} />
                )}
              </div>
            ))}
          </div>
          <div className="mt-1 flex text-[10px]" style={{ color: INK_3 }}>
            {data.hourly.map((h) => (
              <span key={h.hour} className="min-w-0 flex-1 text-center">{h.hour % 6 === 0 ? h.hour : ''}</span>
            ))}
          </div>
        </Card>

        <Card icon={HelpCircle} title="О чём спрашивают клиенты">
          {topics.length === 0
            ? <EmptyState icon={HelpCircle} text="Нет данных" />
            : <Bars items={topics.map((t) => ({ label: t.label, value: t.count }))} />}
        </Card>
      </div>
    </TabBody>
  )
}
