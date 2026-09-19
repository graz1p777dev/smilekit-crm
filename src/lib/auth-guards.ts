// Единые проверки прав для server actions.
//
// Зачем отдельный модуль: проверки были разбросаны по файлам и кое-где
// отсутствовали вовсе, а многие действия ходят в базу admin-клиентом в обход
// RLS — то есть роль там единственная защита. Собранные в одном месте, они
// перестают «забываться» при добавлении нового действия.

import { createClient } from '@/lib/supabase/server'
import type { UserRole } from '@/types'

export interface Viewer {
  id: string
  role: UserRole
  name: string
  /** Раздел «Аналитика» закрыт лично этому сотруднику (миграция 069). */
  analytics_blocked?: boolean
}

/** Текущий сотрудник или null, если сессии нет. */
export async function currentViewer(): Promise<Viewer | null> {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null

  const { data } = await supabase
    .from('employees')
    .select('id, role, name, analytics_blocked')
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .maybeSingle()

  return (data as Viewer | null) ?? null
}

export type GuardFailure = { success: false; error: string }

const NO_SESSION: GuardFailure = { success: false, error: 'Нет авторизации' }
const NO_RIGHTS: GuardFailure = { success: false, error: 'Недостаточно прав' }

/**
 * Пускает только перечисленные роли. Возвращает либо сотрудника, либо готовый
 * объект ошибки — вызывающему коду достаточно проверить `'success' in result`.
 */
export async function requireRole(
  ...roles: UserRole[]
): Promise<Viewer | GuardFailure> {
  const viewer = await currentViewer()
  if (!viewer) return NO_SESSION
  if (!roles.includes(viewer.role)) return NO_RIGHTS
  return viewer
}

/** Любой сотрудник с активной сессией. */
export async function requireEmployee(): Promise<Viewer | GuardFailure> {
  const viewer = await currentViewer()
  return viewer ?? NO_SESSION
}

/** Руководство: видит данные всей компании (выручка, зарплаты, аналитика). */
export const requireManagement = () => requireRole('owner', 'rop')

/**
 * Аналитика: руководство, кроме тех, кому раздел закрыт лично
 * (employees.analytics_blocked) — роль при этом не меняется.
 */
export async function requireAnalytics(): Promise<Viewer | GuardFailure> {
  const viewer = await requireManagement()
  if (isFailure(viewer)) return viewer
  return viewer.analytics_blocked ? NO_RIGHTS : viewer
}

/** Только владелец: настройки, справочники, деньги компании. */
export const requireOwnerRole = () => requireRole('owner')

export function isFailure<T>(result: T | GuardFailure): result is GuardFailure {
  return typeof result === 'object' && result !== null && 'success' in result
}
