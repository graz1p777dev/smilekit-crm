'use client'

// «Настройки» и «Настройки бота» раньше были двумя пунктами меню. Теперь это
// одна страница с двумя вкладками: система CRM и бот. Обе половины приходят
// готовыми узлами — вкладка с ботом рендерится на сервере, потому что его
// внутренний токен не должен попадать в браузер.

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Settings, Bot, MessageCircle, Camera, Users } from 'lucide-react'

type Tab = 'system' | 'staff' | 'bot' | 'whatsapp' | 'instagram'

const TABS: Tab[] = ['system', 'staff', 'bot', 'whatsapp', 'instagram']

function isTab(value: string | null): value is Tab {
  return TABS.includes(value as Tab)
}

export default function SettingsTabs({
  system,
  staff,
  bot,
  whatsapp,
  instagram,
}: {
  system: React.ReactNode
  staff: React.ReactNode
  bot: React.ReactNode
  whatsapp: React.ReactNode
  instagram: React.ReactNode
}) {
  // ?tab=instagram — сюда возвращает OAuth-callback Instagram после подключения.
  const requestedTab = useSearchParams().get('tab')
  const [tab, setTab] = useState<Tab>(isTab(requestedTab) ? requestedTab : 'system')

  const tabs: { key: Tab; label: string; icon: typeof Settings }[] = [
    { key: 'system', label: 'Система', icon: Settings },
    { key: 'staff', label: 'Смены', icon: Users },
    { key: 'bot', label: 'Бот', icon: Bot },
    { key: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
    { key: 'instagram', label: 'Instagram', icon: Camera },
  ]

  return (
    <div className="flex flex-col">
      <div className="flex gap-1 px-4 pt-4 md:px-8" role="tablist">
        {tabs.map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className="flex items-center gap-1.5 rounded-t-xl px-4 py-2.5 text-sm font-semibold transition-colors"
              style={
                tab === t.key
                  ? { background: '#fff', color: '#5115a4', border: '1px solid #ece5e5', borderBottomColor: '#fff' }
                  : { color: '#6b6063', border: '1px solid transparent' }
              }
            >
              <Icon size={14} />
              {t.label}
            </button>
          )
        })}
      </div>
      <div style={{ borderTop: '1px solid #ece5e5', marginTop: -1 }}>
        {/* Обе вкладки остаются в DOM: система — тяжёлая форма с несохранённым
            вводом, размонтировать её при переключении нельзя. */}
        <div hidden={tab !== 'system'}>{system}</div>
        <div hidden={tab !== 'staff'}>{tab === 'staff' && staff}</div>
        <div hidden={tab !== 'bot'}>{bot}</div>
        <div hidden={tab !== 'whatsapp'}>{whatsapp}</div>
        <div hidden={tab !== 'instagram'}>{instagram}</div>
      </div>
    </div>
  )
}
