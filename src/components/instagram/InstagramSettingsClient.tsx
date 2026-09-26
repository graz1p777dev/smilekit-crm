'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { MessageCircle, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import {
  disconnectInstagramAction,
  listInstagramComments,
  setInstagramBotSettingsAction,
  type InstagramCommentRow,
} from '@/actions/instagram-settings'
import { DEFAULT_INSTAGRAM_BOT_SETTINGS, type InstagramIntegration } from '@/lib/instagram/config'
import { humanInstagramError, type InstagramErrorCode } from '@/lib/instagram/errors'

interface Props {
  initialIntegration: InstagramIntegration
}

/** Настройки → Интеграции → Instagram. Клиент никогда не вводит App ID/Secret/токен — только OAuth через кнопку. */
export default function InstagramSettingsClient({ initialIntegration }: Props) {
  const [integration, setIntegration] = useState(initialIntegration)
  const [comments, setComments] = useState<InstagramCommentRow[]>([])
  const [busy, startBusy] = useTransition()
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    if (integration.status !== 'connected') return
    listInstagramComments().then(setComments).catch(() => setComments([]))
  }, [integration.status])

  useEffect(() => {
    const connected = searchParams.get('connected')
    const error = searchParams.get('error')
    if (connected) toast.success('Instagram подключён')
    if (error) toast.error(humanInstagramError(error as InstagramErrorCode))
    if (connected || error) router.replace('/dashboard/settings?tab=instagram')
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
      setIntegration({
        status: 'not_connected',
        instagramAccountId: null,
        username: null,
        scopes: [],
        connectedAt: null,
        lastError: null,
        bot: DEFAULT_INSTAGRAM_BOT_SETTINGS,
      })
      toast.success('Instagram отключён')
    })
  }

  function handleToggle(key: 'dmEnabled' | 'commentsEnabled', value: boolean) {
    const previous = integration.bot
    setIntegration((current) => ({ ...current, bot: { ...current.bot, [key]: value } }))
    startBusy(async () => {
      const result = await setInstagramBotSettingsAction({ [key]: value })
      if (!result.success) {
        setIntegration((current) => ({ ...current, bot: previous }))
        toast.error(result.error)
        return
      }
      toast.success(value ? 'Бот включён' : 'Бот выключен')
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
          <div className="mb-5 space-y-3 rounded-xl p-4" style={{ background: '#f5f6f8' }}>
            <div className="text-sm font-semibold" style={{ color: '#17102a' }}>Автоответы бота</div>
            <label className="flex cursor-pointer items-start gap-2 text-sm" style={{ color: '#4e4560' }}>
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={integration.bot.dmEnabled}
                disabled={busy}
                onChange={(e) => handleToggle('dmEnabled', e.target.checked)}
              />
              <span>Отвечать в личных сообщениях</span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm" style={{ color: '#4e4560' }}>
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={integration.bot.commentsEnabled}
                disabled={busy}
                onChange={(e) => handleToggle('commentsEnabled', e.target.checked)}
              />
              <span>Отвечать на комментарии под постами</span>
            </label>
            <p className="text-xs" style={{ color: '#766d88' }}>
              Пока выключено, сообщения и комментарии только сохраняются в CRM — клиентам бот не пишет.
              Ответы на комментарии требуют разрешения на управление комментариями: если аккаунт
              подключён раньше, нажмите «Подключить Instagram» ещё раз.
            </p>
          </div>
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

      {integration.status === 'connected' && comments.length > 0 && (
        <div className="mt-6 rounded-2xl border p-6" style={{ borderColor: '#e5e7eb', background: '#ffffff' }}>
          <h2 className="mb-4 text-sm font-semibold" style={{ color: '#17102a' }}>
            Комментарии под постами
          </h2>
          <ul className="space-y-3">
            {comments.map((comment) => (
              <li key={comment.id} className="rounded-xl p-3 text-sm" style={{ background: '#f5f6f8' }}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-semibold" style={{ color: '#17102a' }}>
                    {comment.author_username ? `@${comment.author_username}` : 'Без ника'}
                  </span>
                  {comment.commented_at && (
                    <span className="text-xs" style={{ color: '#766d88' }}>
                      {new Date(comment.commented_at).toLocaleString('ru-RU')}
                    </span>
                  )}
                </div>
                <p className="mt-1" style={{ color: '#4e4560' }}>{comment.text}</p>
                {comment.reply_text ? (
                  <p className="mt-2" style={{ color: '#5115a4' }}>
                    Ответ бота: {comment.reply_text}
                    {comment.private_reply_sent ? ' · написали в директ' : ''}
                  </p>
                ) : (
                  <p className="mt-2 text-xs" style={{ color: '#766d88' }}>
                    {comment.status === 'failed' ? 'Ответить не удалось' : 'Без ответа бота'}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
