'use client'

// Единая страница «Аналитика». Период общий для вкладок с цифрами владельца;
// неактивная вкладка НЕ смонтирована — иначе открытие страницы запускало бы
// сразу все загрузки. Вкладка «Бот» живёт по своим правилам.

import { useCallback, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Bot, CalendarDays, Filter, Handshake, Megaphone, MessagesSquare, ShoppingBag, UsersRound } from 'lucide-react'
import type { PeriodInput, PeriodKind } from '@/lib/analytics/period'
import LeadsAnalyticsView from './ConversionAnalytics'
import PurchaseAnalytics from './PurchaseAnalytics'
import StaffAnalytics from './StaffAnalytics'
import BotAnalytics from './BotAnalytics'
import HandoffAnalytics from './HandoffAnalytics'
import FunnelAnalytics from './FunnelAnalytics'
import CampaignAnalytics from './CampaignAnalytics'
import type { Stamp } from './useAnalyticsData'
import { BRAND, BRAND_SOFT, INK, INK_2, INK_3, LINE } from './viz'

type Tab = 'leads' | 'handoff' | 'funnel' | 'purchases' | 'staff' | 'campaigns' | 'bot'

const TABS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: 'leads', label: 'Лиды и конверсия', icon: MessagesSquare },
  { key: 'handoff', label: 'Передача от бота', icon: Handshake },
  { key: 'funnel', label: 'Воронка сделок', icon: Filter },
  { key: 'purchases', label: 'Покупки', icon: ShoppingBag },
  { key: 'staff', label: 'Сотрудники', icon: UsersRound },
  { key: 'campaigns', label: 'Рассылки', icon: Megaphone },
  { key: 'bot', label: 'Бот', icon: Bot },
]

const PERIODS: { key: Exclude<PeriodKind, 'custom'>; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
  { key: 'month', label: 'Этот месяц' },
  { key: 'all', label: 'За всё время' },
]

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Bishkek', hour: '2-digit', minute: '2-digit' })

function PeriodPicker({ value, onChange }: { value: PeriodInput; onChange: (p: PeriodInput) => void }) {
  const [from, setFrom] = useState(value.from ?? '')
  const [to, setTo] = useState(value.to ?? '')
  const [customOpen, setCustomOpen] = useState(value.kind === 'custom')
  const customValid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to

  const segment = (active: boolean) =>
    `shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${active ? '' : 'hover:bg-white/70'}`
  const segmentStyle = (active: boolean) =>
    active
      ? { background: '#fff', color: BRAND, boxShadow: '0 1px 3px rgba(23,16,42,0.12)' }
      : { color: INK_2 }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0" role="radiogroup" aria-label="Период">
        <div className="inline-flex gap-0.5 rounded-xl p-1" style={{ background: '#ece6f5' }}>
          {PERIODS.map((p) => {
            const active = value.kind === p.key && !customOpen
            return (
              <button key={p.key} type="button" role="radio" aria-checked={active}
                onClick={() => { setCustomOpen(false); onChange({ kind: p.key }) }}
                className={segment(active)} style={segmentStyle(active)}>
                {p.label}
              </button>
            )
          })}
          <button type="button" role="radio" aria-checked={value.kind === 'custom' || customOpen}
            onClick={() => setCustomOpen(true)}
            className={`${segment(value.kind === 'custom' || customOpen)} inline-flex items-center gap-1.5`}
            style={segmentStyle(value.kind === 'custom' || customOpen)}>
            <CalendarDays className="size-3.5" aria-hidden />
            Свои даты
          </button>
        </div>
      </div>
      {customOpen && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs" style={{ color: INK_3 }}>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg bg-white px-2 py-1.5" style={{ border: `1px solid ${LINE}`, color: INK }} aria-label="С даты" />
          —
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="rounded-lg bg-white px-2 py-1.5" style={{ border: `1px solid ${LINE}`, color: INK }} aria-label="По дату" />
          <button
            type="button"
            disabled={!customValid}
            onClick={() => onChange({ kind: 'custom', from, to })}
            className="rounded-lg px-3 py-1.5 font-semibold text-white disabled:opacity-40"
            style={{ background: BRAND }}
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
  const [stamp, setStamp] = useState<Stamp | null>(null)
  const onStamp = useCallback((s: Stamp | null) => setStamp(s), [])

  const switchTab = (next: Tab) => { setStamp(null); setTab(next) }

  return (
    <div className="flex min-w-0 flex-col">
      <header className="flex flex-col gap-4 px-4 pt-5 md:px-8 md:pt-7">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight md:text-[26px]" style={{ color: INK, fontFamily: 'var(--font-display)' }}>
            Аналитика
          </h1>
          <p className="mt-1 text-xs leading-relaxed" style={{ color: INK_3 }}>
            {tab === 'bot'
              ? 'Переписка и заказы за последние 30 дней, считается при открытии вкладки.'
              : <>
                  {stamp ? <strong className="font-semibold" style={{ color: INK_2 }}>
                    {stamp.kind === 'computed' ? 'Посчитано' : 'Загружено'} в {clock(stamp.at)}.
                  </strong> : 'Считаем…'}
                  {' '}Дни — по времени Бишкека, целиком. Цифры — прямо из базы, пересчёт не реже раза в 2 минуты.
                </>}
          </p>
        </div>

        <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0" style={{ borderBottom: `1px solid ${LINE}` }}>
          <div className="flex w-max gap-1" role="tablist">
            {TABS.map((t) => {
              const active = tab === t.key
              const Icon = t.icon
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => switchTab(t.key)}
                  className="relative flex shrink-0 items-center gap-1.5 rounded-t-lg px-3 pb-2.5 pt-2 text-sm font-semibold transition-colors hover:bg-[#f7f3fc]"
                  style={{ color: active ? BRAND : INK_3 }}
                >
                  <span className="grid size-6 place-items-center rounded-md" style={{ background: active ? BRAND_SOFT : 'transparent' }}>
                    <Icon className="size-4" aria-hidden />
                  </span>
                  {t.label}
                  {active && <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full" style={{ background: BRAND }} aria-hidden />}
                </button>
              )
            })}
          </div>
        </div>

        {tab !== 'bot' && <PeriodPicker value={period} onChange={setPeriod} />}
      </header>

      {tab === 'leads' && <LeadsAnalyticsView period={period} onStamp={onStamp} />}
      {tab === 'handoff' && <HandoffAnalytics period={period} onStamp={onStamp} />}
      {tab === 'funnel' && <FunnelAnalytics period={period} onStamp={onStamp} />}
      {tab === 'purchases' && <PurchaseAnalytics period={period} onStamp={onStamp} />}
      {tab === 'campaigns' && <CampaignAnalytics period={period} onStamp={onStamp} />}
      {tab === 'staff' && <StaffAnalytics period={period} onStamp={onStamp} />}
      {tab === 'bot' && <BotAnalytics />}
    </div>
  )
}
