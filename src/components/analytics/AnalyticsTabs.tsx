'use client'

// Единая страница «Аналитика». Период общий для вкладок с цифрами владельца;
// неактивная вкладка НЕ смонтирована — иначе открытие страницы запускало бы
// сразу все загрузки. Вкладка «Бот» живёт по своим правилам.

import { useState } from 'react'
import type { PeriodInput, PeriodKind } from '@/lib/analytics/period'
import LeadsAnalyticsView from './ConversionAnalytics'
import PurchaseAnalytics from './PurchaseAnalytics'
import StaffAnalytics from './StaffAnalytics'
import BotAnalytics from './BotAnalytics'
import { INK_3, LINE } from './viz'

type Tab = 'leads' | 'purchases' | 'staff' | 'bot'

const TABS: { key: Tab; label: string }[] = [
  { key: 'leads', label: 'Лиды и конверсия' },
  { key: 'purchases', label: 'Покупки' },
  { key: 'staff', label: 'Сотрудники' },
  { key: 'bot', label: 'Бот' },
]

const PERIODS: { key: Exclude<PeriodKind, 'custom'>; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
  { key: 'month', label: 'Этот месяц' },
]

function PeriodPicker({ value, onChange }: { value: PeriodInput; onChange: (p: PeriodInput) => void }) {
  const [from, setFrom] = useState(value.from ?? '')
  const [to, setTo] = useState(value.to ?? '')
  const [customOpen, setCustomOpen] = useState(value.kind === 'custom')
  const customValid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to

  const active = { background: '#5115a4', color: '#fff' }
  const idle = { color: INK_3 }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1 rounded-xl p-1" style={{ background: '#fdfbfb', border: `1px solid ${LINE}` }}>
        {PERIODS.map((p) => (
          <button
            key={p.key}
            onClick={() => { setCustomOpen(false); onChange({ kind: p.key }) }}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
            style={value.kind === p.key ? active : idle}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setCustomOpen(true)}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
          style={value.kind === 'custom' || customOpen ? active : idle}
        >
          Свои даты
        </button>
      </div>
      {customOpen && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs" style={{ color: INK_3 }}>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg bg-white px-2 py-1.5" style={{ border: `1px solid ${LINE}` }} aria-label="С даты" />
          —
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="rounded-lg bg-white px-2 py-1.5" style={{ border: `1px solid ${LINE}` }} aria-label="По дату" />
          <button
            disabled={!customValid}
            onClick={() => onChange({ kind: 'custom', from, to })}
            className="rounded-lg px-3 py-1.5 font-semibold disabled:opacity-40"
            style={active}
          >
            Показать
          </button>
        </div>
      )}
    </div>
  )
}

export default function AnalyticsTabs() {
  const [tab, setTab] = useState<Tab>('leads')
  const [period, setPeriod] = useState<PeriodInput>({ kind: 'today' })

  return (
    <div className="flex flex-col">
      <div className="flex gap-1 overflow-x-auto px-4 pt-4 md:px-8" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className="shrink-0 rounded-t-xl px-4 py-2.5 text-sm font-semibold transition-colors"
            style={
              tab === t.key
                ? { background: '#fff', color: '#5115a4', border: '1px solid #ece5e5', borderBottomColor: '#fff' }
                : { color: '#6b6063', border: '1px solid transparent' }
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ borderTop: '1px solid #ece5e5', marginTop: -1 }}>
        {tab !== 'bot' && (
          <div className="px-4 pt-4 md:px-8">
            <PeriodPicker value={period} onChange={setPeriod} />
            <p className="mt-1.5 text-[11px]" style={{ color: INK_3 }}>
              Дни — по времени Бишкека, целиком. Цифры — прямо из базы, пересчёт не реже раза в 2 минуты.
            </p>
          </div>
        )}
        {tab === 'leads' && <LeadsAnalyticsView period={period} />}
        {tab === 'purchases' && <PurchaseAnalytics period={period} />}
        {tab === 'staff' && <StaffAnalytics period={period} />}
        {tab === 'bot' && <BotAnalytics />}
      </div>
    </div>
  )
}
