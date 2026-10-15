'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Activity, AlertTriangle, CheckCircle2, LifeBuoy } from 'lucide-react'
import { getBotHealth, getChatLog, recoverAfterOutage, type BotHealth, type BotLogRow } from '@/actions/bot-health'

const REFRESH_MS = 20_000

function ago(iso: string | null): string {
  if (!iso) return 'нет данных'
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин назад`
  return `${Math.floor(min / 60)} ч ${min % 60} мин назад`
}

function Row({ row }: { row: BotLogRow }) {
  return (
    <li className="rounded-lg px-3 py-2 text-xs" style={{ background: row.level === 'error' ? '#fee2e2' : '#fef3c7', color: '#17102a' }}>
      <span className="font-semibold">{row.event}</span>
      {row.chat_id && <span> · {row.chat_id}</span>}
      <span style={{ color: '#766d88' }}> · {new Date(row.created_at).toLocaleString('ru-RU')}</span>
      <div className="mt-0.5 break-words" style={{ color: '#4e4560' }}>{JSON.stringify(row.details)}</div>
    </li>
  )
}

/** Здоровье бота: статус движка, ожидающие клиенты, кнопка восстановления, журнал за 3 дня. */
export default function BotHealthPanel() {
  const [health, setHealth] = useState<BotHealth | null>(null)
  const [chatLog, setChatLog] = useState<{ chatId: string; rows: BotLogRow[] } | null>(null)
  const [busy, startBusy] = useTransition()

  const load = useCallback(() => {
    getBotHealth().then(setHealth).catch(() => setHealth(null))
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [load])

  if (!health) return null

  const engineDown = health.engine.failedLast15Min > 0 && health.engine.okLast15Min === 0
  const canRecover = health.waiting.some((chat) => chat.botCanReply) && !health.recovery.running
  const statusColor = engineDown ? '#b91c1c' : health.waiting.length > 0 ? '#b45309' : '#15803d'
  const StatusIcon = engineDown ? AlertTriangle : CheckCircle2

  function handleRecover() {
    const count = health?.waiting.filter((chat) => chat.botCanReply).length ?? 0
    if (!window.confirm(`Бот ответит ${count} клиентам, которые ждут ответа. Продолжить?`)) return
    startBusy(async () => {
      const result = await recoverAfterOutage()
      if (!result.success) toast.error(result.error)
      else toast.success(`Восстановление запущено: ${result.total} чатов`)
      load()
    })
  }

  async function openChat(chatId: string) {
    setChatLog({ chatId, rows: await getChatLog(chatId) })
  }

  return (
    <div className="mb-6 rounded-2xl border p-5" style={{ borderColor: '#e5e7eb', background: '#ffffff' }}>
      <div className="mb-3 flex items-center gap-2">
        <Activity size={18} color="#5115a4" />
        <h2 className="text-sm font-semibold" style={{ color: '#17102a' }}>Здоровье бота</h2>
        <span className="ml-auto flex items-center gap-1 text-xs font-semibold" style={{ color: statusColor }}>
          <StatusIcon size={14} />
          {engineDown ? 'Движок бота не отвечает' : health.waiting.length > 0 ? 'Есть клиенты без ответа' : 'Всё в порядке'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4" style={{ color: '#4e4560' }}>
        <div className="rounded-xl p-3" style={{ background: '#f5f6f8' }}>Green API: <b>{health.greenApi}</b></div>
        <div className="rounded-xl p-3" style={{ background: '#f5f6f8' }}>Движок ответил: <b>{ago(health.engine.lastOkAt)}</b></div>
        <div className="rounded-xl p-3" style={{ background: '#f5f6f8' }}>Повторов в очереди: <b>{health.retriesPending}</b></div>
        <div className="rounded-xl p-3" style={{ background: '#f5f6f8' }}>Память CRM: <b>{health.memory.rssMb} МБ</b></div>
        <div className="rounded-xl p-3" style={{ background: '#f5f6f8' }}>За 24 ч принято: <b>{health.last24h.inbound}</b></div>
        <div className="rounded-xl p-3" style={{ background: '#f5f6f8' }}>Отправлено: <b>{health.last24h.sent}</b></div>
        <div className="rounded-xl p-3" style={{ background: '#f5f6f8' }}>Ошибок отправки: <b>{health.last24h.sendFailed}</b></div>
        <div className="rounded-xl p-3" style={{ background: '#f5f6f8' }}>Сбоев движка: <b>{health.last24h.engineFailed}</b></div>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: '#17102a' }}>Ждут ответа: {health.waiting.length}</span>
          <button
            onClick={handleRecover}
            disabled={!canRecover || busy}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-white disabled:opacity-50"
            style={{ background: '#5115a4' }}
          >
            <LifeBuoy size={14} />
            {health.recovery.running ? `Восстановление: ${health.recovery.done}/${health.recovery.total}` : 'Восстановить после сбоя'}
          </button>
        </div>
        {health.waiting.length > 0 && (
          <ul className="space-y-1">
            {health.waiting.map((chat) => (
              <li key={chat.chatId} className="flex items-baseline gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: '#f5f6f8', color: '#4e4560' }}>
                <button onClick={() => openChat(chat.chatId)} className="font-semibold underline" style={{ color: '#17102a' }}>{chat.chatId}</button>
                <span>{chat.ageMin} мин · {chat.preview || '—'}</span>
                {!chat.botCanReply && <span className="ml-auto shrink-0" style={{ color: '#766d88' }}>бот молчит (менеджер/выкл.)</span>}
              </li>
            ))}
          </ul>
        )}
        {health.recovery.running === false && health.recovery.startedAt && (
          <p className="mt-2 text-xs" style={{ color: '#766d88' }}>
            Последнее восстановление: ответили {health.recovery.replied}, пропущено {health.recovery.skipped}
          </p>
        )}
      </div>

      {chatLog && (
        <div className="mt-4">
          <div className="mb-1 flex items-center text-xs font-semibold" style={{ color: '#17102a' }}>
            Журнал чата {chatLog.chatId}
            <button onClick={() => setChatLog(null)} className="ml-auto" style={{ color: '#766d88' }}>закрыть</button>
          </div>
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {chatLog.rows.map((row) => (
              <li key={row.id} className="rounded-lg px-3 py-1.5 text-xs" style={{ background: '#f5f6f8', color: '#4e4560' }}>
                {new Date(row.created_at).toLocaleString('ru-RU')} · <b>{row.event}</b> · {JSON.stringify(row.details)}
              </li>
            ))}
            {chatLog.rows.length === 0 && <li className="text-xs" style={{ color: '#766d88' }}>Событий за 3 дня нет</li>}
          </ul>
        </div>
      )}

      <div className="mt-4">
        <div className="mb-1 text-sm font-semibold" style={{ color: '#17102a' }}>Проблемы за 3 дня</div>
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {health.problems.map((row) => <Row key={row.id} row={row} />)}
          {health.problems.length === 0 && <li className="text-xs" style={{ color: '#766d88' }}>Проблем нет</li>}
        </ul>
      </div>
    </div>
  )
}
