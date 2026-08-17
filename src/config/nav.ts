import type { LucideIcon } from 'lucide-react'
import type { UserRole } from '@/types'
import { FinanceNavIcon } from '@/components/finance/FinanceDesignerIcons'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  roles: UserRole[]
  exact?: boolean
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

import {
  LayoutDashboard,
  BarChart3,
  Megaphone,
  DollarSign,
  Users,
  Calendar,
  Bell,
  FileText,
  Settings,
  FileBarChart2,
  SlidersHorizontal,
  FlaskConical,
  HelpCircle,
  KanbanSquare,
  Sparkles,
  Handshake,
  Package,
  Send,
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
        // боту витрины или в WhatsApp/Instagram — бухгалтеру не нужна.
        href: '/dashboard/deals',
        label: 'Сделки',
        icon: Handshake,
        roles: ['owner', 'rop', 'mp', 'lmai'],
      },
      {
        // Заказы из Telegram-бота. Бухгалтеру не нужны — он работает
        // с итогами в «Финансах», а не с отгрузками.
        href: '/dashboard/orders',
        label: 'Заказы',
        icon: Package,
        roles: ['owner', 'rop', 'mp', 'lmai'],
      },
      {
        href: '/dashboard/campaigns',
        label: 'Рассылки',
        icon: Send,
        roles: ['owner', 'rop'],
      },
      {
        href: '/dashboard/customers',
        label: 'Клиенты',
        icon: Handshake,
        roles: ['owner', 'rop', 'mp', 'lmai'],
      },
      {
        href: '/dashboard/copilot',
        label: 'ИИ-помощник',
        icon: Sparkles,
        roles: ['owner', 'rop', 'mp', 'lmai', 'accountant'],
      },
    ],
  },
  {
    label: 'AI Бот',
    items: [
      {
        href: '/dashboard/bot-analytics',
        label: 'Аналитика бота',
        icon: BarChart3,
        roles: ['owner', 'rop'],
      },
      {
        href: '/dashboard/bot-reports',
        label: 'Отчёты бота',
        icon: FileBarChart2,
        roles: ['owner', 'rop'],
      },
      {
        href: '/dashboard/bot-settings',
        label: 'Настройки бота',
        icon: SlidersHorizontal,
        roles: ['owner'],
      },
      {
        href: '/dashboard/whatsapp-settings',
        label: 'WhatsApp: шаблоны и доставка',
        icon: SlidersHorizontal,
        roles: ['owner'],
      },
      {
        href: '/dashboard/laboratory',
        label: 'Лаборатория',
        icon: FlaskConical,
        roles: ['owner'],
      },
      {
        href: '/dashboard/whatsapp-lab',
        label: 'Лаборатория WhatsApp',
        icon: FlaskConical,
        roles: ['owner'],
      },
    ],
  },
  {
    label: 'Аналитика',
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
        href: '/dashboard/finance',
        label: 'Финансы',
        icon: FinanceNavIcon,
        roles: ['owner', 'accountant'],
      },
      {
        href: '/dashboard/marketing',
        label: 'Маркетинг',
        icon: Megaphone,
        roles: ['owner', 'rop'],
      },
      {
        href: '/dashboard/purchase-analytics',
        label: 'Аналитика покупок',
        icon: BarChart3,
        roles: ['owner', 'rop'],
      },
    ],
  },
  {
    label: 'Управление',
    items: [
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
      {
        href: '/dashboard/documents',
        label: 'Документы',
        icon: FileText,
        roles: ['owner', 'accountant', 'rop'],
      },
    ],
  },
  {
    label: 'Система',
    items: [
      {
        href: '/dashboard/settings',
        label: 'Настройки',
        icon: Settings,
        roles: ['owner'],
      },
      {
        href: '/dashboard/help',
        label: 'Помощь',
        icon: HelpCircle,
        roles: ['owner', 'rop', 'mp', 'lmai', 'accountant'],
      },
    ],
  },
]
