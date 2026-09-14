'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { cn } from '@/lib/utils'
import { ROLE_LABELS } from '@/lib/constants'
import { getInitials } from '@/lib/formatters'
import { NAV_GROUPS } from '@/config/nav'
import { LogOut } from 'lucide-react'
import type { UserRole } from '@/types'

function isActiveLink(pathname: string, href: string, exact?: boolean): boolean {
  if (exact) return pathname === href
  return pathname === href || pathname.startsWith(href + '/')
}

interface SidebarProps {
  mobileOpen?: boolean
  onClose?: () => void
}

export default function Sidebar({ mobileOpen = false, onClose }: SidebarProps) {
  const pathname = usePathname()
  const { user, signOut } = useAuth()
  const role = user?.role as UserRole | undefined

  // Десктоп: свёрнут до иконок, раскрывается по наведению или фокусу с клавиатуры.
  // Мобильный drawer всегда раскрыт целиком.
  const [hovered, setHovered] = useState(false)
  const expanded = mobileOpen || hovered

  // Скользящая подсветка активного пункта
  const itemRefs = useRef<Map<string, HTMLAnchorElement | null>>(new Map())
  const [indicator, setIndicator] = useState<{ top: number; height: number; visible: boolean }>({
    top: 0, height: 0, visible: false,
  })
  const [animate, setAnimate] = useState(false)

  const activeHref = (() => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (role && item.roles.includes(role) && isActiveLink(pathname, item.href, item.exact)) {
          return item.href
        }
      }
    }
    return null
  })()

  useLayoutEffect(() => {
    const el = activeHref ? itemRefs.current.get(activeHref) : null
    if (el) {
      setIndicator({ top: el.offsetTop, height: el.offsetHeight, visible: true })
      // включаем плавность только после первой установки позиции
      const id = requestAnimationFrame(() => setAnimate(true))
      return () => cancelAnimationFrame(id)
    } else {
      setIndicator(prev => ({ ...prev, visible: false }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHref, role])

  // На мобильном: закрывать drawer при переходе на другую страницу
  useEffect(() => {
    onClose?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  return (
    <>
      {/* Колонка-распорка под fixed-панель. Ширина ПОСТОЯННА (w-16): раньше
          она анимировалась до w-48 на каждое наведение мыши и вместе с
          сайдбаром двигала всю страницу — то есть браузер пересчитывал
          раскладку всего содержимого 200 мс подряд каждый раз, когда курсор
          просто проходил над меню. Теперь раскрытая панель накрывает контент
          сверху (у неё уже есть тень), а страница не шевелится. */}
      <div aria-hidden className="hidden w-16 flex-shrink-0 md:block" />

      <aside
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setHovered(true)}
        onBlurCapture={() => setHovered(false)}
        className={cn(
          'flex flex-col h-screen overflow-hidden',
          'fixed inset-y-0 left-0 z-50 transition-all duration-200 ease-out',
          'w-48 md:translate-x-0',
          hovered ? 'md:w-48 md:shadow-2xl' : 'md:w-16',
          mobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full',
        )}
        style={{
          background: 'linear-gradient(180deg, #5115a4 0%, #360e7f 100%)',
          borderRight: '1px solid rgba(255,255,255,0.14)',
          boxShadow: '8px 0 28px -18px rgba(81, 21, 164,0.45)',
        }}
      >
      {/* Логотип */}
      <div
        className="flex items-center gap-3 px-4 py-4 flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.18)' }}
      >
        <div
          className="brand-mark flex-shrink-0"
          style={{ width: 32, height: 32 }}
          aria-hidden
        />
        <div
          className={cn(
            'min-w-0 transition-opacity duration-200',
            expanded ? 'opacity-100' : 'opacity-0',
          )}
        >
          <p className="brand-wordmark text-white truncate whitespace-nowrap" style={{ fontSize: 14 }}>
            smilekit
          </p>
          <p style={{ fontSize: 11, color: '#ffffff' }} className="truncate whitespace-nowrap">
            CRM система
          </p>
        </div>
      </div>

      {/* Навигация */}
      <nav className="flex-1 overflow-y-auto px-2 py-3" style={{ scrollbarWidth: 'none' }}>
        <div className="relative">
          {/* Скользящая подсветка */}
          <div
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: indicator.top,
              height: indicator.height,
              background: '#ffffff',
              borderRadius: 8,
              boxShadow: '0 4px 14px -4px rgba(40,26,28,0.34), inset 0 0 0 1px rgba(255,255,255,0.9)',
              opacity: indicator.visible ? 1 : 0,
              transition: animate
                ? 'top 260ms cubic-bezier(0.22,1,0.36,1), height 260ms cubic-bezier(0.22,1,0.36,1), opacity 150ms ease'
                : 'opacity 150ms ease',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />
          {NAV_GROUPS.map((group) => {
            const visible = group.items.filter(
              (item) => role && item.roles.includes(role)
            )
            if (!visible.length) return null

            return (
              <div key={group.label} className="mb-5">
                <p
                  className={cn(
                    'px-2 mb-1 uppercase tracking-widest font-semibold truncate whitespace-nowrap',
                    'transition-opacity duration-200',
                    expanded ? 'opacity-100' : 'opacity-0',
                  )}
                  style={{ fontSize: 10, color: '#ffffff' }}
                >
                  {group.label}
                </p>
                <ul className="space-y-0.5">
                  {visible.map((item) => {
                    const active = isActiveLink(pathname, item.href, item.exact)
                    const Icon = item.icon
                    const LinkTag = Link
                    // Золотой акцент (accent: 'gold'): на фиолетовом фоне —
                    // янтарь #f5a623, на белой подсветке активного пункта
                    // янтаря не хватает по контрасту, там #b45309.
                    const gold = item.accent === 'gold'
                    const goldText = active ? '#b45309' : '#f5a623'

                    return (
                      <li key={item.href}>
                        <LinkTag
                          ref={(el) => { itemRefs.current.set(item.href, el) }}
                          href={item.href}
                          // По умолчанию Next.js префетчит данные КАЖДОЙ ссылки
                          // в сайдбаре (12+ пунктов), едва они попадают в
                          // вьюпорт — на каждую навигацию это залповая нагрузка
                          // на сервер, под которой другие запросы (например
                          // server actions вроде переключателя бота) могут
                          // зависать без ответа и без ошибки, блокируя UI
                          // до перезагрузки страницы (см. BotToggle).
                          prefetch={false}
                          title={expanded ? undefined : item.label}
                          className={cn(
                            'relative flex items-center gap-2.5 px-2.5 py-2 rounded-md transition-colors duration-150 outline-none',
                            gold
                              ? 'font-medium hover:bg-white/[0.14] focus-visible:bg-white/[0.14]'
                              : active
                                ? 'text-[#5115a4] font-medium'
                                : 'text-white hover:bg-white/[0.14] hover:text-white focus-visible:bg-white/[0.14] focus-visible:text-white'
                          )}
                          style={{ zIndex: 1, color: gold ? goldText : undefined }}
                        >
                          <span
                            className="relative flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-lg"
                            style={{
                              background: gold
                                ? 'rgba(245,166,35,0.20)'
                                : active
                                  ? 'rgba(81, 21, 164,0.10)'
                                  : 'rgba(255,255,255,0.16)',
                              boxShadow: 'none',
                            }}
                            aria-hidden
                          >
                            <span
                              aria-hidden
                              style={{
                                position: 'absolute',
                                right: -8,
                                top: -10,
                                width: 18,
                                height: 18,
                                borderRadius: 999,
                                backgroundColor: gold
                                  ? 'rgba(245,166,35,0.16)'
                                  : active
                                    ? 'rgba(81, 21, 164,0.08)'
                                    : 'rgba(255,255,255,0.10)',
                              }}
                            />
                            <Icon
                              style={{
                                position: 'relative',
                                width: 14,
                                height: 14,
                                color: gold ? goldText : active ? '#5115a4' : '#ffffff',
                                flexShrink: 0,
                              }}
                            />
                          </span>
                          <span
                            className={cn(
                              'truncate whitespace-nowrap transition-opacity duration-200',
                              expanded ? 'opacity-100' : 'opacity-0',
                            )}
                            style={{ fontSize: 13, fontWeight: active || gold ? 500 : 400 }}
                          >
                            {item.label}
                          </span>
                        </LinkTag>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </div>
      </nav>

      {/* Пользователь */}
      <div
        className="flex-shrink-0 px-3 py-3"
        style={{ borderTop: '1px solid rgba(255,255,255,0.18)' }}
      >
        <div className="flex items-center gap-2.5">
          {/* Аватар */}
          <div
            className="flex items-center justify-center rounded-full flex-shrink-0 text-white font-semibold brand-gradient"
            style={{
              width: 30, height: 30,
              fontSize: 11,
            }}
          >
            {user?.name ? getInitials(user.name) : '??'}
          </div>

          {/* Имя и роль */}
          <div
            className={cn(
              'flex-1 min-w-0 transition-opacity duration-200',
              expanded ? 'opacity-100' : 'opacity-0',
            )}
          >
            <p className="text-white font-medium truncate whitespace-nowrap" style={{ fontSize: 12 }}>
              {user?.name ?? 'Загрузка...'}
            </p>
            <p style={{ fontSize: 11, color: '#ffffff' }} className="truncate whitespace-nowrap">
              {role ? ROLE_LABELS[role] : ''}
            </p>
          </div>

          {/* Выход */}
          <button
            onClick={() => signOut()}
            className={cn(
              'flex-shrink-0 transition-all duration-200',
              expanded ? 'opacity-100' : 'opacity-0 pointer-events-none',
            )}
            style={{ color: 'rgba(255,255,255,0.9)' }}
            title="Выйти"
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = '#ffffff'
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = 'rgba(255,255,255,0.9)'
            }}
          >
            <LogOut style={{ width: 15, height: 15 }} />
          </button>
        </div>
      </div>
      </aside>
    </>
  )
}
