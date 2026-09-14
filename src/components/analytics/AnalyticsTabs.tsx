'use client'

// Единая страница «Аналитика»: три раздела на вкладках вместо трёх пунктов
// меню. Неактивная вкладка НЕ смонтирована — иначе открытие страницы
// запускало бы сразу три независимые загрузки данных.

import { useEffect, useState } from 'react'
import { getConversionAnalytics, type ConversionAnalytics } from '@/actions/analytics'
import { recoverFromStaleAction } from '@/lib/stale-action'
import ConversionAnalyticsView from './ConversionAnalytics'
import PurchaseAnalytics from './PurchaseAnalytics'
import BotAnalytics from './BotAnalytics'

type Tab = 'conversion' | 'purchases' | 'bot'

const TABS: { key: Tab; label: string }[] = [
  { key: 'conversion', label: 'Конверсии и продажи' },
  { key: 'purchases', label: 'Покупки' },
  { key: 'bot', label: 'Бот' },
]

export default function AnalyticsTabs() {
  const [tab, setTab] = useState<Tab>('conversion')
  const [conversion, setConversion] = useState<ConversionAnalytics | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Считаем после открытия страницы, а не до неё: перебор переписки за год
  // занимает секунды, и раньше страница успевала оборваться по таймауту.
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      getConversionAnalytics()
        .then((data) => { if (alive) setConversion(data) })
        .catch((err: unknown) => {
          if (!alive || recoverFromStaleAction(err)) return
          setError('Не удалось посчитать аналитику')
        })
    }, 0)
    return () => { alive = false; clearTimeout(timer) }
  }, [])

  return (
    <div className="flex flex-col">
      <div className="flex gap-1 px-4 pt-4 md:px-8" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className="rounded-t-xl px-4 py-2.5 text-sm font-semibold transition-colors"
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
        {tab === 'conversion' && (
          error
            ? <p className="p-8 text-sm" style={{ color: '#b91c1c' }}>{error}</p>
            : conversion
              ? <ConversionAnalyticsView data={conversion} />
              : <p className="p-8 text-sm" style={{ color: '#6b6063' }}>Считаем конверсии…</p>
        )}
        {tab === 'purchases' && <PurchaseAnalytics />}
        {tab === 'bot' && <BotAnalytics />}
      </div>
    </div>
  )
}
