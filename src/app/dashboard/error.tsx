'use client'
import { useEffect } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { recoverFromStaleAction } from '@/lib/stale-action'

interface DashboardErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

export default function DashboardError({ error, reset }: DashboardErrorProps) {
  useEffect(() => {
    console.error('[Dashboard error]', error)
    // Вкладка, открытая до деплоя, зовёт серверное действие по старому
    // идентификатору и падает с «Server Action … was not found». Чинится
    // перезагрузкой — делаем её сами, один раз, вместо того чтобы показывать
    // пользователю техническую ошибку. Здесь, в общей границе ошибок, это
    // прикрывает сразу все страницы дашборда.
    recoverFromStaleAction(error)
  }, [error])

  return (
    <div
      className="flex flex-col items-center justify-center gap-4"
      style={{ height: 'calc(100vh - 52px)' }}
    >
      <div
        className="flex items-center justify-center rounded-full"
        style={{ width: 48, height: 48, backgroundColor: '#fdeaea' }}
      >
        <AlertTriangle style={{ width: 22, height: 22, color: '#b91c1c' }} />
      </div>
      <div className="text-center">
        <p className="font-semibold" style={{ fontSize: 15, color: '#1b1517' }}>
          Ошибка загрузки дашборда
        </p>
        <p style={{ fontSize: 13, color: '#7d7174', marginTop: 4, maxWidth: 320 }}>
          {error.message || 'Что-то пошло не так. Попробуйте обновить страницу.'}
        </p>
      </div>
      <button
        onClick={reset}
        className="flex items-center gap-2 rounded-xl px-4 py-2 font-medium transition-opacity hover:opacity-80"
        style={{
          backgroundColor: '#5115a4',
          color: '#ffffff',
          fontSize: 13,
          cursor: 'pointer',
          border: 'none',
        }}
      >
        <RefreshCw style={{ width: 14, height: 14 }} />
        Попробовать снова
      </button>
    </div>
  )
}
