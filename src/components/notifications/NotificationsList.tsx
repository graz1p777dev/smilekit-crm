'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Bell, Check, CheckCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/contexts/AuthContext'
import { getNotifications, markAllNotificationsRead, markNotificationRead } from '@/actions/notifications'
import { NOTIFICATION_TYPE_MAP } from '@/lib/constants'
import type { Notification } from '@/types'

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', {
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function NotificationsList({
  initialItems,
  initialFilter,
}: {
  initialItems: Notification[]
  initialFilter: 'all' | 'important'
}) {
  const [items, setItems] = useState(initialItems)
  const [isPending, startTransition] = useTransition()
  const { user } = useAuth()
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    if (!user?.id) return
    const channel = supabase
      .channel('notifications-page')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `employee_id=eq.${user.id}` },
        (payload) => setItems(prev => [payload.new as Notification, ...prev])
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [user?.id, supabase])

  useEffect(() => {
    if (initialFilter !== 'all') return
    const timer = window.setInterval(() => {
      void getNotifications('all').then(setItems)
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [initialFilter])

  const unreadCount = items.filter(n => !n.is_read).length

  function handleMarkRead(id: string) {
    setItems(prev => prev.map(n => (n.id === id ? { ...n, is_read: true } : n)))
    startTransition(() => { markNotificationRead(id) })
  }

  function handleMarkAllRead() {
    setItems(prev => prev.map(n => ({ ...n, is_read: true })))
    startTransition(() => { markAllNotificationsRead() })
  }

  function setFilter(filter: 'all' | 'important') {
    router.push(filter === 'important' ? '/dashboard/notifications?filter=important' : '/dashboard/notifications')
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-4">
        <h1 className="font-semibold flex flex-wrap items-center gap-x-2" style={{ fontSize: 18, color: '#1b1517' }}>
          <Bell style={{ width: 18, height: 18 }} />
          Уведомления
          {unreadCount > 0 && (
            <span style={{ fontSize: 12, color: '#7d7174', fontWeight: 400 }}>
              · {unreadCount} непрочитанных
            </span>
          )}
        </h1>
        <button
          onClick={handleMarkAllRead}
          disabled={isPending || unreadCount === 0}
          className="flex min-h-9 items-center gap-1.5 rounded-md transition-colors disabled:opacity-40 md:min-h-0"
          style={{ fontSize: 12, color: '#5115a4', padding: '6px 10px' }}
        >
          <CheckCheck style={{ width: 14, height: 14 }} />
          Прочитать всё
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setFilter('all')}
          className="min-h-9 rounded-md transition-colors md:min-h-0"
          style={{
            fontSize: 12, padding: '6px 12px',
            backgroundColor: initialFilter === 'all' ? '#5115a4' : '#fdfbfb',
            color: initialFilter === 'all' ? '#fff' : '#6b7280',
          }}
        >
          Все
        </button>
        <button
          onClick={() => setFilter('important')}
          className="min-h-9 rounded-md transition-colors md:min-h-0"
          style={{
            fontSize: 12, padding: '6px 12px',
            backgroundColor: initialFilter === 'important' ? '#5115a4' : '#fdfbfb',
            color: initialFilter === 'important' ? '#fff' : '#6b7280',
          }}
        >
          Важные
        </button>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-12" style={{ color: '#7d7174', fontSize: 13 }}>
          Уведомлений нет
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((n) => {
            const meta = NOTIFICATION_TYPE_MAP[n.type] ?? NOTIFICATION_TYPE_MAP.system
            const content = (
              <div
                className="flex items-start gap-3 rounded-lg transition-colors"
                style={{
                  padding: '12px 14px',
                  backgroundColor: n.is_read ? '#ffffff' : '#fdfbfb',
                  border: '1px solid #ebebee',
                }}
              >
                <span
                  className="flex items-center justify-center rounded-full flex-shrink-0"
                  style={{ width: 28, height: 28, backgroundColor: meta.bg, fontSize: 13 }}
                >
                  {meta.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 break-words font-medium" style={{ fontSize: 13, color: '#1b1517' }}>
                      {n.title}
                    </span>
                    {!n.is_read && (
                      <span className="rounded-full flex-shrink-0" style={{ width: 6, height: 6, backgroundColor: '#5115a4' }} />
                    )}
                  </div>
                  {n.body && (
                    <p className="break-words" style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{n.body}</p>
                  )}
                  <span style={{ fontSize: 11, color: '#7d7174' }}>{formatDateTime(n.created_at)}</span>
                </div>
                {!n.is_read && (
                  <button
                    onClick={(e) => { e.preventDefault(); handleMarkRead(n.id) }}
                    title="Отметить прочитанным"
                    className="-m-2 flex size-10 items-center justify-center rounded-md flex-shrink-0 md:m-0 md:size-6"
                    style={{ color: '#7d7174' }}
                    aria-label="Отметить прочитанным"
                  >
                    <Check style={{ width: 14, height: 14 }} />
                  </button>
                )}
              </div>
            )
            return n.action_url ? (
              <Link key={n.id} href={n.action_url} onClick={() => handleMarkRead(n.id)}>
                {content}
              </Link>
            ) : (
              <div key={n.id}>{content}</div>
            )
          })}
        </div>
      )}
    </div>
  )
}
