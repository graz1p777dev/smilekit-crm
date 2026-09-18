'use client'

// Вкладка «Рассылки»: каждая рассылка периода — сколько получателей, сколько
// дошло, сколько ответили и купили после неё.

import { getCampaignAnalytics } from '@/lib/analytics/client-api'
import type { PeriodInput } from '@/lib/analytics/period'
import { useAnalyticsData } from './useAnalyticsData'
import { Skeleton } from './ConversionAnalytics'
import { Card, INK_3, LINE, ScrollTable, Stat, num, pct } from './viz'

const STATUS: Record<string, string> = {
  completed: 'завершена', running: 'идёт', scheduled: 'запланирована', cancelled: 'отменена', failed: 'ошибка',
}

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Bishkek', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso))

export default function CampaignAnalytics({ period }: { period: PeriodInput }) {
  const { data, error, loading } = useAnalyticsData(getCampaignAnalytics, period)
  if (error) return <p className="p-8 text-sm" style={{ color: '#b91c1c' }}>{error}</p>
  if (loading || !data) return <Skeleton text="Считаем рассылки…" />

  const sent = data.campaigns.reduce((sum, c) => sum + c.sent, 0)
  const replied = data.campaigns.reduce((sum, c) => sum + c.replied, 0)
  const bought = data.campaigns.reduce((sum, c) => sum + c.bought, 0)

  return (
    <div className="flex flex-col gap-5 p-4 md:p-8">
      <p className="text-xs" style={{ color: INK_3 }}>
        Рассылки, начатые (или назначенные) в эти дни. Ответили — клиент написал в течение 24 часов после отправки ему.
        Купили — заказ с его номера в течение 7 дней после отправки.
      </p>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Stat label="Рассылок" value={num(data.campaigns.length)} />
        <Stat label="Отправлено сообщений" value={num(sent)} />
        <Stat label="Ответили за 24 ч" value={num(replied)} tone="good" sub={pct(replied, sent)} />
        <Stat label="Купили за 7 дней" value={num(bought)} tone="good" sub={pct(bought, sent)} />
      </div>

      <Card title="По рассылкам" hint="Не отправлено — пропущены при отмене или ещё ждут очереди.">
        {data.campaigns.length === 0
          ? <p className="text-sm" style={{ color: INK_3 }}>Рассылок за период не было.</p>
          : (
            <ScrollTable head={['Рассылка', 'Когда', 'Статус', 'Получателей', 'Отправлено', 'Не отправлено', 'Ответили', 'Купили']}>
              {data.campaigns.map((c) => (
                <tr key={c.id} style={{ borderTop: `1px solid ${LINE}` }}>
                  <td className="py-1.5 pr-3">{c.title}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{dateTime(c.at)}</td>
                  <td className="py-1.5 pr-3">{STATUS[c.status] ?? c.status}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{num(c.recipients)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{num(c.sent)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{num(c.skipped + c.pending + c.failed)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{num(c.replied)} ({pct(c.replied, c.sent)})</td>
                  <td className="py-1.5 pr-3 tabular-nums">{num(c.bought)}</td>
                </tr>
              ))}
            </ScrollTable>
          )}
      </Card>
    </div>
  )
}
