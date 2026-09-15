'use client'

// Живой ход рассылки: кому уже ушло, кому нет, где ошибка.
// Пока рассылка идёт, список опрашивается каждые 3 секунды; когда она
// завершена, опрос не нужен — данные уже окончательные.

import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Clock3, Loader2, X } from 'lucide-react'
import { getCampaignRecipients, type CampaignRecipientRow } from '@/actions/campaigns'
import { recoverFromStaleAction } from '@/lib/stale-action'

const STATUS: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: 'в очереди', color: '#6b6570', bg: '#f1eef3' },
  sending: { label: 'отправляется', color: '#9a6700', bg: '#fff5cc' },
  sent: { label: 'доставлено', color: '#087a55', bg: '#ddf8ed' },
  failed: { label: 'ошибка', color: '#b42318', bg: '#fee4e2' },
  skipped: { label: 'пропущен', color: '#6b6570', bg: '#f1eef3' },
}

export default function CampaignProgress({
  campaignId,
  running,
  sent,
  total,
}: {
  campaignId: string
  running: boolean
  sent: number
  total: number
}) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<CampaignRecipientRow[] | null>(null)

  const load = useCallback(() => {
    getCampaignRecipients(campaignId)
      .then(setRows)
      .catch((error: unknown) => { recoverFromStaleAction(error) })
  }, [campaignId])

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(load, 0)
    // Пока идёт отправка — обновляем часто; завершённую рассылку
    // перечитывать незачем.
    const poll = running ? setInterval(load, 3_000) : null
    return () => {
      clearTimeout(timer)
      if (poll) clearInterval(poll)
    }
  }, [open, running, load])

  // Если список получателей уже загружен, считаем по нему: это самые свежие
  // данные, они не ждут записи счётчика в карточку рассылки.
  const liveSent = rows?.filter((row) => row.status === 'sent').length
  const shownSent = liveSent ?? sent
  const pct = total ? Math.round((shownSent / total) * 100) : 0

  return (
    <div className="mt-3">
      {/* Полоса прогресса — видна всегда, разворачивать не нужно */}
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: '#f1eef3' }}>
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${pct}%`, background: running ? '#9a6700' : '#087a55' }}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums" style={{ color: 'var(--ink-3)' }}>
          {shownSent} из {total}
        </span>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex shrink-0 items-center gap-1 text-xs font-semibold"
          style={{ color: '#5115a4' }}
        >
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {open ? 'Скрыть' : 'Кому отправлено'}
        </button>
      </div>

      {open && (
        <div className="mt-2 max-h-72 overflow-y-auto rounded-xl" style={{ background: 'var(--surface-2)' }}>
          {rows === null ? (
            <p className="flex items-center gap-2 p-3 text-xs" style={{ color: 'var(--ink-3)' }}>
              <Loader2 className="size-3.5 animate-spin" /> Загружаем список…
            </p>
          ) : rows.length === 0 ? (
            <p className="p-3 text-xs" style={{ color: 'var(--ink-3)' }}>Получателей нет</p>
          ) : (
            rows.map((row) => {
              const meta = STATUS[row.status] ?? STATUS.pending
              const Icon = row.status === 'sent' ? Check : row.status === 'failed' ? X : Clock3
              return (
                <div
                  key={row.id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                  style={{ borderTop: '1px solid rgba(28,20,22,0.06)' }}
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>
                      {row.name || 'Без имени'}
                    </p>
                    <p className="truncate text-[11px] tabular-nums" style={{ color: 'var(--ink-3)' }}>
                      +{row.chat_id}
                      {row.error && ` · ${row.error}`}
                    </p>
                  </div>
                  <span
                    className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                    style={{ color: meta.color, background: meta.bg }}
                  >
                    <Icon className="size-3" />
                    {meta.label}
                  </span>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
