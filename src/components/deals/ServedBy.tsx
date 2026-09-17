'use client'

// «Кто обслуживал»: сотрудники на смене в моменты сообщений человека в чате.
// Двое на смене одновременно — «вместе». Используется в сделке и в карточке
// клиента.

import { useEffect, useState } from 'react'
import { UsersRound } from 'lucide-react'
import { getDealServedBy, type DealServedBy } from '@/actions/deal-served-by'
import type { ServedGroup } from '@/lib/analytics/client-profile'

const messagesWord = (n: number) => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'сообщение'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'сообщения'
  return 'сообщений'
}

export function ServedGroupsView({ hasChat, humanMessages, served }: DealServedBy) {
  if (!hasChat) return <p className="text-[12px] text-gray-400">Переписки WhatsApp с этим номером нет.</p>
  if (humanMessages === 0) return <p className="text-[12px] text-gray-400">Человек в этом чате не писал.</p>

  const onShift = served.filter((g) => g.names.length > 0)
  const offShift = served.find((g: ServedGroup) => g.names.length === 0)

  return (
    <div className="space-y-1 text-[12px]">
      {onShift.length === 0 && <p className="text-gray-500">Смен в это время не было.</p>}
      {onShift.map((g) => (
        <div key={g.names.join('|')} className="flex items-baseline justify-between gap-2">
          <span className="font-medium text-gray-900">
            {g.names.length > 1 ? `${g.names.join(' и ')} (вместе)` : g.names[0]}
          </span>
          <span className="shrink-0 tabular-nums text-gray-500">{g.messages} {messagesWord(g.messages)}</span>
        </div>
      ))}
      {offShift && onShift.length > 0 && (
        <div className="flex items-baseline justify-between gap-2 text-gray-500">
          <span>Вне смен</span>
          <span className="shrink-0 tabular-nums">{offShift.messages} {messagesWord(offShift.messages)}</span>
        </div>
      )}
      <p className="text-[11px] text-gray-400">
        По сменам в моменты сообщений человека в чате. Всего сообщений человека: {humanMessages}.
      </p>
    </div>
  )
}

export default function ServedBy({ dealId }: { dealId: string }) {
  const [state, setState] = useState<{ dealId: string; data: DealServedBy | null } | null>(null)

  useEffect(() => {
    let alive = true
    getDealServedBy(dealId)
      .then((data) => { if (alive) setState({ dealId, data }) })
      .catch(() => { if (alive) setState({ dealId, data: null }) })
    return () => { alive = false }
  }, [dealId])

  // Нет прав, нет номера или ошибка — блок просто не показываем.
  if (state && state.dealId === dealId && state.data === null) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <UsersRound size={14} className="text-gray-400" />
        <span className="text-sm font-medium">Кто обслуживал</span>
      </div>
      {!state || state.dealId !== dealId || !state.data
        ? <p className="text-[12px] text-gray-400">Загружаем…</p>
        : <ServedGroupsView {...state.data} />}
    </div>
  )
}
