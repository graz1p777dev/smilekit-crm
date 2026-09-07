'use client'

import { useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Power } from 'lucide-react'
import { getAmoBotEnabled, setAmoBotEnabled, pauseAmoBot } from '@/actions/amocrm-bot'

/** Аварийный выключатель бота amoCRM — живёт в шапке доски сделок. */
export function AmoBotToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, startBusy] = useTransition()

  useEffect(() => {
    getAmoBotEnabled().then((result) => {
      if (result.success) setEnabled(result.enabled)
    })
  }, [])

  function handleToggle() {
    if (enabled == null) return
    const next = !enabled
    startBusy(async () => {
      // Сервер иногда не отвечает вовсе — не ошибкой, а зависшим запросом
      // (см. префетч в Sidebar.tsx: залповая нагрузка при навигации может
      // подвесить параллельный запрос без таймаута и без ответа). Без гонки
      // с таймаутом кнопка оставалась disabled навсегда, до жёсткой
      // перезагрузки страницы — busy никогда не сбрасывался.
      const timedOut = Symbol('timeout')
      const result = await Promise.race([
        setAmoBotEnabled(next),
        new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), 10_000)),
      ])
      if (result === timedOut) {
        toast.error('Сервер не ответил — попробуйте ещё раз через несколько секунд')
        return
      }
      if (!result.success) {
        toast.error(result.error)
        return
      }
      setEnabled(next)
      toast.success(next ? 'Бот amoCRM включён — отвечает клиентам' : 'Бот amoCRM ВЫКЛЮЧЕН — молчит во всех чатах')
    })
  }

  function handlePause(minutes: number | null) {
    startBusy(async () => {
      const result = await pauseAmoBot(minutes)
      if (!result.success) {
        toast.error(result.error)
        return
      }
      if (minutes === null) setEnabled(false)
      toast.success(
        minutes ? `Бот amoCRM на паузе ${minutes} мин. — потом включится сам` : 'Бот amoCRM ВЫКЛЮЧЕН — молчит во всех чатах'
      )
    })
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={handleToggle}
        disabled={busy || enabled == null}
        className="flex h-9 items-center gap-1.5 rounded-xl px-3 text-[13px] font-semibold transition-colors disabled:opacity-60"
        style={
          enabled
            ? { background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' }
            : { background: '#fee2e2', color: '#b91c1c', border: '1px solid #fca5a5' }
        }
        title="Мгновенно глушит ответы бота в WhatsApp-чатах amoCRM. История и этапы сделок продолжают вестись."
      >
        <Power size={14} />
        {enabled == null ? 'Бот…' : enabled ? 'Бот: ВКЛ' : 'Бот: ВЫКЛ'}
      </button>
      <select
        disabled={busy || enabled == null}
        defaultValue=""
        onChange={(e) => {
          const value = e.target.value
          e.target.value = ''
          if (value === '15') handlePause(15)
          else if (value === '60') handlePause(60)
          else if (value === 'manual') handlePause(null)
        }}
        className="h-9 rounded-xl border px-2 text-[13px] disabled:opacity-60"
        title="Временная пауза бота — сам включится по истечении"
      >
        <option value="" disabled>Пауза…</option>
        <option value="15">15 мин</option>
        <option value="60">1 час</option>
        <option value="manual">До ручного включения</option>
      </select>
    </div>
  )
}
