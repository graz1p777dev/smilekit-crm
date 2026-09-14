import type { LucideIcon } from 'lucide-react'
import type { UserRole } from '@/types'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  roles: UserRole[]
  exact?: boolean
  /** 'gold' — золотая подсветка в сайдбаре: пункт, за которым следят каждый день. */
  accent?: 'gold'
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

import {
  LayoutDashboard,
  BarChart3,
  DollarSign,
  Users,
  Calendar,
  Bell,
  Settings,
  KanbanSquare,
  Handshake,
  Package,
  Send,
  TrendingUp,
} from 'lucide-react'

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Главное',
    items: [
      {
        href: '/dashboard',
        label: 'Дашборд',
        icon: LayoutDashboard,
        roles: ['owner', 'rop', 'mp', 'lmai'],
        exact: true,
      },
      {
        // Воронка продаж. Сделки заводятся сами, как только клиент написал
        // боту витрины или в WhatsApp/Instagram.
        href: '/dashboard/deals',
        label: 'Сделки',
        icon: Handshake,
        roles: ['owner', 'rop', 'mp', 'lmai'],
      },
      {
        href: '/dashboard/orders',
        label: 'Заказы',
        icon: Package,
        roles: ['owner', 'rop', 'mp', 'lmai'],
      },
      {
        href: '/dashboard/customers',
        label: 'Клиенты',
        icon: Users,
        roles: ['owner', 'rop', 'mp', 'lmai'],
      },
      {
        href: '/dashboard/campaigns',
        label: 'Рассылки',
        icon: Send,
        roles: ['owner', 'rop'],
      },
    ],
  },
  {
    label: 'Аналитика',
    items: [
      {
        // Одна страница на всю аналитику: конверсии и продажи, покупки, бот.
        // Раньше это были три отдельных пункта меню.
        href: '/dashboard/analytics',
        label: 'Аналитика',
        icon: TrendingUp,
        roles: ['owner', 'rop'],
        accent: 'gold',
      },
    ],
  },
  {
    label: 'Другое',
    items: [
      {
        href: '/dashboard/decomposition',
        label: 'Декомпозиция',
        icon: BarChart3,
        roles: ['owner', 'rop', 'mp', 'lmai'],
      },
      {
        href: '/dashboard/salary',
        label: 'Зарплата',
        icon: DollarSign,
        roles: ['owner', 'rop', 'mp', 'lmai', 'accountant'],
      },
      {
        href: '/dashboard/tasks',
        label: 'Задачи',
        icon: KanbanSquare,
        roles: ['owner', 'rop', 'mp', 'lmai', 'accountant'],
      },
      {
        href: '/dashboard/employees',
        label: 'Сотрудники',
        icon: Users,
        roles: ['owner', 'rop'],
      },
      {
        href: '/dashboard/calendar',
        label: 'Календарь',
        icon: Calendar,
        roles: ['owner', 'rop', 'mp', 'lmai'],
      },
      {
        href: '/dashboard/notifications',
        label: 'Уведомления',
        icon: Bell,
        roles: ['owner', 'rop', 'mp', 'lmai', 'accountant'],
      },
    ],
  },
  {
    label: 'Система',
    items: [
      {
        // Настройки бота переехали внутрь «Настроек» отдельной вкладкой —
        // отдельного пункта меню у них больше нет.
        href: '/dashboard/settings',
        label: 'Настройки',
        icon: Settings,
        roles: ['owner'],
      },
    ],
  },
]
