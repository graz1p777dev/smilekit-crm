'use client'

// Вкладка «Рассылки»: каждая рассылка периода — сколько получателей, сколько
// дошло, сколько ответили и купили после неё.

import { Megaphone, MessageCircleReply, Send, ShoppingBag } from 'lucide-react'
import { getCampaignAnalytics, type CampaignStat } from '@/lib/analytics/client-api'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData, useReportStamp, type Stamp } from './useAnalyticsData'
import {
  BRAND, BRAND_SOFT, Card, EmptyState, ErrorState, INK, INK_2, INK_3, Kpi, KpiGrid, LINE, Lead, SERIES, ScrollTable, TRACK,
  TabBody, TabSkeleton, num, pct,
} from './viz'

const STATUS: Record<string, string> = {
  completed: 'завершена', running: 'идёт', scheduled: 'запланирована', cancelled: 'отменена', failed: 'ошибка',
}

/** Статус — плашкой; красный только у «ошибка» (это и есть сбой). */
const STATUS_STYLE: Record<string, { background: string; color: string }> = {
  completed: { background: '#e3f4f1', color: '#0f766e' },
  running: { background: BRAND_SOFT, color: BRAND },
  scheduled: { background: '#f4f1f8', color: INK_2 },
  cancelled: { background: '#f4f1f8', color: INK_3 },
  failed: { background: '#fdecec', color: '#b91c1c' },
}

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Bishkek', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso))

export default function CampaignAnalytics({ period, onStamp }: { period: PeriodInput; onStamp?: (s: Stamp | null) => void }) {
  const { data, error, loading, loadedAt } = useAnalyticsData(getCampaignAnalytics, period)
  useReportStamp(null, loadedAt, onStamp)
  if (error) return <ErrorState text={error} />
  if (loading || !data) return <TabSkeleton text="Считаем рассылки…" blocks={['list']} />
  return <CampaignsView data={data} />
}

export function CampaignsView({ data }: { data: { campaigns: CampaignStat[] } }) {
  const sent = data.campaigns.reduce((sum, c) => sum + c.sent, 0)
  const replied = data.campaigns.reduce((sum, c) => sum + c.replied, 0)
  const bought = data.campaigns.reduce((sum, c) => sum + c.bought, 0)
  const topReply = Math.max(...data.campaigns.map((c) => (c.sent ? c.replied / c.sent : 0)), 0.0001)

  return (
    <TabBody>
      <Lead>
        Рассылки, начатые (или назначенные) в эти дни. Ответили — клиент написал в течение 24 часов после отправки ему.
        Купили — заказ с его номера в течение 7 дней после отправки.
      </Lead>

      <KpiGrid>
        <Kpi hero icon={Megaphone} label="Рассылок" value={num(data.campaigns.length)} sub="начаты или назначены в эти дни" />
        <Kpi icon={Send} label="Отправлено сообщений" value={num(sent)} />
        <Kpi icon={MessageCircleReply} tone="good" label="Ответили за 24 ч" value={num(replied)} sub={`${pct(replied, sent)} от отправленных`} />
        <Kpi icon={ShoppingBag} tone="good" label="Купили за 7 дней" value={num(bought)} sub={`${pct(bought, sent)} от отправленных`} />
      </KpiGrid>

      <Card icon={Megaphone} title="По рассылкам" hint="Не отправлено — пропущены при отмене или ещё ждут очереди. Полоса у «Ответили» — доля ответивших, сравнение между рассылками.">
        {data.campaigns.length === 0
          ? <EmptyState icon={Megaphone} text="Рассылок за период не было" />
          : (
            <ScrollTable minWidth={760} head={['Рассылка', 'Когда', 'Статус', 'Получателей', 'Отправлено', 'Не отправлено', 'Ответили', 'Купили']}>
              {data.campaigns.map((c) => {
                const rate = c.sent ? c.replied / c.sent : 0
                return (
                  <tr key={c.id} style={{ borderTop: `1px solid ${LINE}` }}>
                    <td className="max-w-[220px] py-2.5 pr-3 font-medium" style={{ color: INK }}>{c.title}</td>
                    <td className="whitespace-nowrap py-2.5 pr-3 tabular-nums" style={{ color: INK_2 }}>{dateTime(c.at)}</td>
                    <td className="py-2.5 pr-3">
                      <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold"
                        style={STATUS_STYLE[c.status] ?? STATUS_STYLE.scheduled}>
                        {STATUS[c.status] ?? c.status}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 tabular-nums">{num(c.recipients)}</td>
                    <td className="py-2.5 pr-3 tabular-nums">{num(c.sent)}</td>
                    <td className="py-2.5 pr-3 tabular-nums" style={{ color: INK_2 }}>{num(c.skipped + c.pending + c.failed)}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2 tabular-nums" title={`Ответили ${num(c.replied)} из ${num(c.sent)}`}>
                        <span className="whitespace-nowrap">{num(c.replied)} <span style={{ color: INK_3 }}>({pct(c.replied, c.sent)})</span></span>
                        <span className="h-1.5 w-12 shrink-0 rounded-full" style={{ background: TRACK }} aria-hidden>
                          {rate > 0 && <span className="block h-full rounded-full" style={{ width: `${Math.max(6, (rate / topReply) * 100)}%`, background: SERIES[1] }} />}
                        </span>
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 font-semibold tabular-nums">{num(c.bought)}</td>
                  </tr>
                )
              })}
            </ScrollTable>
          )}
      </Card>
    </TabBody>
  )
}
