'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isFailure, requireOwnerRole } from '@/lib/auth-guards'
import { recordAudit } from '@/actions/audit'

export type ActionResult = { success: true } | { success: false; error: string }

export interface DeptRow {
  id: string
  name: string
  description: string | null
  is_active: boolean
}

export interface RoleRow {
  id: string
  name: string
  label: string
  description: string | null
  is_system: boolean
  permission_level: string
}

export interface WorkScheduleRow {
  id: string
  name: string
  description: string | null
  is_system: boolean
  is_active: boolean
}

export interface DealStageRow {
  id: string
  name: string
  description: string | null
  color: string
  sort_order: number
  kind: 'normal' | 'won' | 'lost'
  is_default: boolean
}

// ─── Auth guard ────────────────────────────────────────────────────────────────

async function requireSession() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  return session
}

// ─── Departments ───────────────────────────────────────────────────────────────

export async function getDepartments(): Promise<DeptRow[]> {
  const session = await requireSession()
  if (!session) return []
  const supabase = await createClient()
  const { data } = await supabase
    .from('departments')
    .select('id, name, description, is_active')
    .eq('is_active', true)
    .order('name')
  return (data ?? []) as DeptRow[]
}

export async function createDepartment(name: string, description: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  // Справочники правит только владелец. Раньше хватало любой сессии, а
  // пишет этот код admin-клиентом в обход RLS — то есть менеджер мог
  // переименовать этапы воронки или удалить отдел.
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const admin = createAdminClient()
  const { data: created, error } = await admin.from('departments').insert({
    name: name.trim(),
    description: description.trim() || null,
    is_active: true,
  }).select('id').maybeSingle()
  if (error) return { success: false, error: error.message }
  await recordAudit({ action: 'create', resourceType: 'department', resourceId: created?.id, summary: `Создан отдел «${name.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function updateDepartment(id: string, name: string, description: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  // Справочники правит только владелец. Раньше хватало любой сессии, а
  // пишет этот код admin-клиентом в обход RLS — то есть менеджер мог
  // переименовать этапы воронки или удалить отдел.
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const admin = createAdminClient()
  const { error } = await admin.from('departments').update({
    name: name.trim(),
    description: description.trim() || null,
    updated_at: new Date().toISOString(),
  }).eq('id', id)
  if (error) return { success: false, error: error.message }
  await recordAudit({ action: 'update', resourceType: 'department', resourceId: id, summary: `Изменён отдел «${name.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function deleteDepartment(id: string): Promise<ActionResult> {
  // Справочники правит только владелец. Раньше хватало любой сессии, а
  // пишет этот код admin-клиентом в обход RLS — то есть менеджер мог
  // переименовать этапы воронки или удалить отдел.
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const admin = createAdminClient()
  const { count } = await admin.from('employees')
    .select('id', { count: 'exact', head: true })
    .eq('department_id', id)
    .is('deleted_at', null)
  if (count && count > 0) {
    return { success: false, error: `Нельзя удалить: к этому отделу привязаны сотрудники (${count} чел.) — сначала переведите их в другой отдел` }
  }
  const { data: removed } = await admin.from('departments').select('name').eq('id', id).maybeSingle()
  const { error } = await admin.from('departments').delete().eq('id', id)
  if (error) return { success: false, error: error.message }
  await recordAudit({ action: 'delete', resourceType: 'department', resourceId: id, summary: `Удалён отдел «${removed?.name ?? ''}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── Roles ─────────────────────────────────────────────────────────────────────

export async function getRoles(): Promise<RoleRow[]> {
  const session = await requireSession()
  if (!session) return []
  const supabase = await createClient()
  const { data } = await supabase
    .from('roles')
    .select('id, name, label, description, is_system, permission_level')
    .is('deleted_at', null)
    .order('created_at')
  return (data ?? []) as RoleRow[]
}

export async function createRole(
  name: string,
  label: string,
  description: string,
  permissionLevel: 'employee' | 'department_head',
): Promise<ActionResult> {
  if (!label.trim()) return { success: false, error: 'Название роли обязательно' }
  const slug = (name || label).trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  if (!slug) return { success: false, error: 'Системное имя должно содержать латинские буквы' }
  // Справочники правит только владелец. Раньше хватало любой сессии, а
  // пишет этот код admin-клиентом в обход RLS — то есть менеджер мог
  // переименовать этапы воронки или удалить отдел.
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const admin = createAdminClient()
  const { error } = await admin.from('roles').insert({
    name: slug,
    label: label.trim(),
    description: description.trim() || null,
    permission_level: permissionLevel,
    is_system: false,
  })
  if (error) return { success: false, error: error.message }
  await recordAudit({ action: 'create', resourceType: 'role', summary: `Создана роль «${label.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function updateRole(
  id: string,
  label: string,
  description: string,
  permissionLevel?: 'employee' | 'department_head',
): Promise<ActionResult> {
  if (!label.trim()) return { success: false, error: 'Название роли обязательно' }
  // Справочники правит только владелец. Раньше хватало любой сессии, а
  // пишет этот код admin-клиентом в обход RLS — то есть менеджер мог
  // переименовать этапы воронки или удалить отдел.
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const admin = createAdminClient()
  const { data: role } = await admin.from('roles').select('is_system').eq('id', id).single()
  const updates: Record<string, unknown> = {
    // Системные роли: label заблокирован — он отображает name-slug в UI, изменение сломает ориентацию
    ...(role?.is_system ? {} : { label: label.trim() }),
    description: description.trim() || null,
    updated_at: new Date().toISOString(),
  }
  if (!role?.is_system && permissionLevel) updates.permission_level = permissionLevel
  const { error } = await admin.from('roles').update(updates).eq('id', id)
  if (error) return { success: false, error: error.message }
  await recordAudit({ action: 'update', resourceType: 'role', resourceId: id, summary: `Изменена роль «${label.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function deleteRole(id: string): Promise<ActionResult> {
  // Справочники правит только владелец. Раньше хватало любой сессии, а
  // пишет этот код admin-клиентом в обход RLS — то есть менеджер мог
  // переименовать этапы воронки или удалить отдел.
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const admin = createAdminClient()
  const { data: role } = await admin.from('roles').select('is_system, name').eq('id', id).single()
  if (role?.is_system) return { success: false, error: 'Системные роли нельзя удалять' }
  const { count } = await admin.from('employees')
    .select('id', { count: 'exact', head: true })
    .eq('role', role?.name ?? '')
    .is('deleted_at', null)
  if (count && count > 0) {
    return { success: false, error: `Нельзя удалить: к этой роли привязаны сотрудники (${count} чел.) — сначала измените их роль` }
  }
  const { error } = await admin.from('roles').delete().eq('id', id).eq('is_system', false)
  if (error) return { success: false, error: error.message }
  await recordAudit({ action: 'delete', resourceType: 'role', resourceId: id, summary: `Удалена роль «${role?.name ?? ''}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── Work Schedules ────────────────────────────────────────────────────────────

export async function getWorkSchedules(): Promise<WorkScheduleRow[]> {
  const session = await requireSession()
  if (!session) return []
  const supabase = await createClient()
  const { data } = await supabase
    .from('work_schedules')
    .select('id, name, description, is_system, is_active')
    .eq('is_active', true)
    .order('created_at')
  return (data ?? []) as WorkScheduleRow[]
}

export async function createWorkSchedule(name: string, description: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  // Справочники правит только владелец. Раньше хватало любой сессии, а
  // пишет этот код admin-клиентом в обход RLS — то есть менеджер мог
  // переименовать этапы воронки или удалить отдел.
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const admin = createAdminClient()
  const { error } = await admin.from('work_schedules').insert({
    name: name.trim(),
    description: description.trim() || null,
    is_system: false,
    is_active: true,
  })
  if (error) return { success: false, error: error.message }
  await recordAudit({ action: 'create', resourceType: 'work_schedule', summary: `Создан график «${name.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function updateWorkSchedule(id: string, name: string, description: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  // Справочники правит только владелец. Раньше хватало любой сессии, а
  // пишет этот код admin-клиентом в обход RLS — то есть менеджер мог
  // переименовать этапы воронки или удалить отдел.
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const admin = createAdminClient()
  const { error } = await admin.from('work_schedules').update({
    name: name.trim(),
    description: description.trim() || null,
    updated_at: new Date().toISOString(),
  }).eq('id', id)
  if (error) return { success: false, error: error.message }
  await recordAudit({ action: 'update', resourceType: 'work_schedule', resourceId: id, summary: `Изменён график «${name.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

export async function deleteWorkSchedule(id: string): Promise<ActionResult> {
  // Справочники правит только владелец. Раньше хватало любой сессии, а
  // пишет этот код admin-клиентом в обход RLS — то есть менеджер мог
  // переименовать этапы воронки или удалить отдел.
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const admin = createAdminClient()
  const { data: ws } = await admin.from('work_schedules').select('is_system, name').eq('id', id).single()
  if (ws?.is_system) return { success: false, error: 'Системные графики нельзя удалять' }
  const { count } = await admin.from('employees')
    .select('id', { count: 'exact', head: true })
    .eq('schedule_type', ws?.name ?? '')
    .is('deleted_at', null)
  if (count && count > 0) {
    return { success: false, error: `Нельзя удалить: этот график используют ${count} сотр. — сначала измените им график` }
  }
  const { error } = await admin.from('work_schedules').delete().eq('id', id).eq('is_system', false)
  if (error) return { success: false, error: error.message }
  await recordAudit({ action: 'delete', resourceType: 'work_schedule', resourceId: id, summary: `Удалён график «${ws?.name ?? ''}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/employees')
  return { success: true }
}

// ─── Этапы воронки сделок ────────────────────────────────────────────────────

export async function getDealStages(): Promise<DealStageRow[]> {
  const session = await requireSession()
  if (!session) return []
  const supabase = await createClient()
  const { data } = await supabase
    .from('deal_stages')
    .select('id, name, description, color, sort_order, kind, is_default')
    .order('sort_order')
  return (data ?? []) as DealStageRow[]
}

/** Новые этапы всегда 'normal' — 'won'/'lost' зарезервированы под два
 * уже заведённых терминальных этапа, отчётность считает конверсию по ним. */
export async function createDealStage(name: string, description: string, color: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  // Справочники правит только владелец. Раньше хватало любой сессии, а
  // пишет этот код admin-клиентом в обход RLS — то есть менеджер мог
  // переименовать этапы воронки или удалить отдел.
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const admin = createAdminClient()
  const { data: last } = await admin.from('deal_stages')
    .select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle()
  const nextOrder = ((last as { sort_order: number } | null)?.sort_order ?? 0) + 1
  const { data: created, error } = await admin.from('deal_stages').insert({
    name: name.trim(),
    description: description.trim() || null,
    color: color.trim() || '#94a3b8',
    sort_order: nextOrder,
    kind: 'normal',
    is_default: false,
  }).select('id').maybeSingle()
  if (error) return { success: false, error: error.message }
  await recordAudit({ action: 'create', resourceType: 'deal_stage', resourceId: created?.id, summary: `Создан этап воронки «${name.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/deals')
  return { success: true }
}

export async function updateDealStage(id: string, name: string, description: string, color: string): Promise<ActionResult> {
  if (!name.trim()) return { success: false, error: 'Название обязательно' }
  // Справочники правит только владелец. Раньше хватало любой сессии, а
  // пишет этот код admin-клиентом в обход RLS — то есть менеджер мог
  // переименовать этапы воронки или удалить отдел.
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const admin = createAdminClient()
  const { error } = await admin.from('deal_stages').update({
    name: name.trim(),
    description: description.trim() || null,
    color: color.trim() || '#94a3b8',
    updated_at: new Date().toISOString(),
  }).eq('id', id)
  if (error) return { success: false, error: error.message }
  await recordAudit({ action: 'update', resourceType: 'deal_stage', resourceId: id, summary: `Изменён этап воронки «${name.trim()}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/deals')
  return { success: true }
}

export async function deleteDealStage(id: string): Promise<ActionResult> {
  // Справочники правит только владелец. Раньше хватало любой сессии, а
  // пишет этот код admin-клиентом в обход RLS — то есть менеджер мог
  // переименовать этапы воронки или удалить отдел.
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const admin = createAdminClient()
  const { data: stage } = await admin.from('deal_stages').select('name, is_default').eq('id', id).maybeSingle()
  if (!stage) return { success: false, error: 'Этап не найден' }
  if ((stage as { is_default: boolean }).is_default) {
    return { success: false, error: 'Этап по умолчанию нельзя удалить — в него попадают новые сделки' }
  }
  const { count } = await admin.from('deals')
    .select('id', { count: 'exact', head: true })
    .eq('stage_id', id)
    .is('deleted_at', null)
  if (count && count > 0) {
    return { success: false, error: `Нельзя удалить: на этом этапе ${count} сделок(и) — сначала перенесите их на другой этап` }
  }
  const { error } = await admin.from('deal_stages').delete().eq('id', id)
  if (error) return { success: false, error: error.message }
  await recordAudit({ action: 'delete', resourceType: 'deal_stage', resourceId: id, summary: `Удалён этап воронки «${(stage as { name: string }).name}»` })
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard/deals')
  return { success: true }
}
