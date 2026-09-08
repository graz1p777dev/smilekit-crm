'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { MessageCircle, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { disconnectInstagramAction } from '@/actions/instagram-settings'
import type { InstagramIntegration } from '@/lib/instagram/config'
import { humanInstagramError, type InstagramErrorCode } from '@/lib/instagram/errors'

interface Props {
  initialIntegration: InstagramIntegration
}

/** Настройки → Интеграции → Instagram. Клиент никогда не вводит App ID/Secret/токен — только OAuth через кнопку. */
export default function InstagramSettingsClient({ initialIntegration }: Props) {
  const [integration, setIntegration] = useState(initialIntegration)
  const [busy, startBusy] = useTransition()
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const connected = searchParams.get('connected')
    const error = searchParams.get('error')
    if (connected) toast.success('Instagram подключён')
    if (error) toast.error(humanInstagramError(error as InstagramErrorCode))
    if (connected || error) router.replace('/dashboard/instagram-settings')
  }, [searchParams, router])

  function handleDisconnect() {
    startBusy(async () => {
      const timedOut = Symbol('timeout')
      const result = await Promise.race([
        disconnectInstagramAction(),
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
      setIntegration({ status: 'not_connected', instagramAccountId: null, username: null, scopes: [], connectedAt: null, lastError: null })
      toast.success('Instagram отключён')
    })
  }

  const statusMeta = {
    connected: { label: 'Подключено', icon: CheckCircle2, color: '#15803d', bg: '#dcfce7', border: '#86efac' },
    not_connected: { label: 'Не подключено', icon: MessageCircle, color: '#4e4560', bg: '#f5f6f8', border: '#e5e7eb' },
    error: { label: 'Ошибка подключения', icon: XCircle, color: '#b91c1c', bg: '#fee2e2', border: '#fca5a5' },
    reauth_required: { label: 'Нужно переподключить', icon: AlertTriangle, color: '#b45309', bg: '#fef3c7', border: '#fcd34d' },
  }[integration.status]

  const StatusIcon = statusMeta.icon

  return (
    <div className="p-8 max-w-xl">
      <h1 className="text-xl font-semibold mb-6" style={{ color: '#17102a' }}>Instagram</h1>

      <div className="rounded-2xl border p-6" style={{ borderColor: '#e5e7eb', background: '#ffffff' }}>
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: statusMeta.bg }}>
            <StatusIcon size={20} color={statusMeta.color} />
          </div>
          <div>
            <div className="text-sm font-semibold" style={{ color: '#17102a' }}>{statusMeta.label}</div>
            {integration.username && (
              <div className="text-sm" style={{ color: '#766d88' }}>@{integration.username}</div>
            )}
          </div>
        </div>

        {integration.status === 'connected' && (
          <div className="mb-5 space-y-1 text-sm" style={{ color: '#4e4560' }}>
            {integration.instagramAccountId && <div>ID аккаунта: {integration.instagramAccountId}</div>}
            {integration.connectedAt && (
              <div>Подключено: {new Date(integration.connectedAt).toLocaleString('ru-RU')}</div>
            )}
          </div>
        )}

        {integration.lastError && integration.status !== 'connected' && (
          <p className="mb-5 text-sm" style={{ color: '#b91c1c' }}>{integration.lastError}</p>
        )}

        {integration.status === 'not_connected' && (
          <>
            <p className="mb-5 text-sm" style={{ color: '#766d88' }}>
              Подключите Instagram, чтобы получать сообщения прямо в CRM.
            </p>
            <a
              href="/api/instagram/connect"
              className="inline-flex h-10 items-center rounded-xl px-4 text-sm font-semibold text-white"
              style={{ background: '#5115a4' }}
            >
              Подключить Instagram
            </a>
          </>
        )}

        {(integration.status === 'error' || integration.status === 'reauth_required') && (
          <a
            href="/api/instagram/connect"
            className="inline-flex h-10 items-center rounded-xl px-4 text-sm font-semibold text-white"
            style={{ background: '#5115a4' }}
          >
            Переподключить
          </a>
        )}

        {integration.status === 'connected' && (
          <button
            onClick={handleDisconnect}
            disabled={busy}
            className="inline-flex h-10 items-center rounded-xl px-4 text-sm font-semibold disabled:opacity-60"
            style={{ background: '#fee2e2', color: '#b91c1c', border: '1px solid #fca5a5' }}
          >
            Отключить
          </button>
        )}
      </div>
    </div>
  )
}
