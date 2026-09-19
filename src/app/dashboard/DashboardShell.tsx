'use client'
import { useEffect, useState, useTransition } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import Sidebar from '@/components/Sidebar'
import Topbar from '@/components/layout/Topbar'
import { stopImpersonation } from '@/actions/auth'

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const { user, impersonating } = useAuth()
  const [pending, startTransition] = useTransition()
  const [menuOpen, setMenuOpen] = useState(false)

  // Сессия истекла прямо во время работы пользователя — перенаправляем на логин.
  // При первом рендере user всегда установлен (данные пришли с сервера),
  // поэтому это срабатывает только при реальном logout/expiry.
  useEffect(() => {
    if (!user) {
      window.location.href = '/auth/login'
    }
  }, [user])

  if (!user) return null

  const handleExitImpersonation = () => {
    startTransition(async () => {
      await stopImpersonation()
      window.location.href = '/dashboard/employees'
    })
  }

  return (
    <div className="flex min-h-screen">
      {/* Плавающий градиентный фон за всем приложением */}
      <div className="gradient-mesh" aria-hidden>
        <div className="mesh-blob" />
      </div>

      {/* Затемнение под мобильным drawer */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-40 md:hidden backdrop-blur-sm"
          style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
          onClick={() => setMenuOpen(false)}
        />
      )}
      <Sidebar mobileOpen={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0">
        {impersonating && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm font-medium shrink-0 bg-gradient-to-r from-amber-400 to-orange-400 text-amber-950">
            <span>
              👤 Вы просматриваете систему от имени <strong>{impersonating.name}</strong> ({impersonating.role})
            </span>
            <button
              onClick={handleExitImpersonation}
              disabled={pending}
              className="min-h-9 px-3 py-1 rounded-lg text-xs font-semibold transition-colors bg-black/10 hover:bg-black/15"
            >
              {pending ? '...' : '← Выйти в свой аккаунт'}
            </button>
          </div>
        )}
        <Topbar onMenuClick={() => setMenuOpen(true)} />
        <main className="flex-1 min-w-0">
          {children}
        </main>
      </div>
    </div>
  )
}
