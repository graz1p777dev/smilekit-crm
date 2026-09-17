'use server'

// Настройки → «Смены»: владелец заводит сотрудников смен (имя, телефон,
// пароль), указывает свой WhatsApp для подтверждений, видит, кто на смене,
// и может закрыть забытую смену или решить запрос сам.
// Всё только для владельца: таблицы смен читаются admin-клиентом в обход RLS.

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { isFailure, requireOwnerRole } from '@/lib/auth-guards'
import { hashStaffPassword } from '@/lib/staff/crypto'
import { normalizeStaffPhone, validateStaffPassword } from '@/lib/staff/rules'
import { closeShiftByOwner, decideShiftRequest } from '@/lib/staff/service'
import { publicAppUrl, readStaffShiftSettings } from '@/lib/staff/notify'

export type AdminResult = { success: true } | { success: false; error: string }

export interface StaffAdminData {
  portalUrl: string
  ownerWhatsapp: string | null
  staff: {
    id: string
    fullName: string
    phone: string
    telegramLinked: boolean
    isActive: boolean
    onShiftSince: string | null
    mode: 'solo' | 'joint' | null
  }[]
  pending: { id: string; kind: 'take' | 'join'; requesterName: string; createdAt: string }[]
  recentShifts: {
    id: string
    staffName: string
    mode: 'solo' | 'joint'
    startedAt: string
    endedAt: string | null
    endedReason: string | null
  }[]
}

export async function getStaffAdminData(): Promise<StaffAdminData | null> {
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return null

  const admin = createAdminClient()
  const [settings, { data: members }, { data: shifts }, { data: pending }] = await Promise.all([
    readStaffShiftSettings(),
    admin.from('staff_members').select('id, full_name, phone, telegram_id, is_active').order('full_name'),
    admin
      .from('staff_shifts')
      .select('id, staff_id, mode, started_at, ended_at, ended_reason')
      .order('started_at', { ascending: false })
      .limit(30),
    admin
      .from('staff_shift_requests')
      .select('id, kind, requester_id, created_at')
      .eq('status', 'pending')
      .gte('created_at', new Date(Date.now() - 30 * 60_000).toISOString())
      .order('created_at'),
  ])

  const people = (members ?? []) as { id: string; full_name: string; phone: string; telegram_id: number | null; is_active: boolean }[]
  const nameOf = new Map(people.map((p) => [p.id, p.full_name]))
  const shiftRows = (shifts ?? []) as { id: string; staff_id: string; mode: 'solo' | 'joint'; started_at: string; ended_at: string | null; ended_reason: string | null }[]

  return {
    portalUrl: `${publicAppUrl()}/smena`,
    ownerWhatsapp: settings.ownerWhatsapp,
    staff: people.map((p) => {
      const open = shiftRows.find((s) => s.staff_id === p.id && !s.ended_at)
      return {
        id: p.id,
        fullName: p.full_name,
        phone: p.phone,
        telegramLinked: p.telegram_id !== null,
        isActive: p.is_active,
        onShiftSince: open?.started_at ?? null,
        mode: open?.mode ?? null,
      }
    }),
    pending: ((pending ?? []) as { id: string; kind: 'take' | 'join'; requester_id: string; created_at: string }[]).map((r) => ({
      id: r.id, kind: r.kind, requesterName: nameOf.get(r.requester_id) ?? '—', createdAt: r.created_at,
    })),
    recentShifts: shiftRows.map((s) => ({
      id: s.id,
      staffName: nameOf.get(s.staff_id) ?? '—',
      mode: s.mode,
      startedAt: s.started_at,
      endedAt: s.ended_at,
      endedReason: s.ended_reason,
    })),
  }
}

interface StaffInput {
  fullName: string
  phone: string
  /** Пустой при редактировании — пароль не меняется. */
  password: string
}

function validate(input: StaffInput, passwordRequired: boolean): { error: string } | { fullName: string; phone: string } {
  const fullName = input.fullName.trim().replace(/\s+/g, ' ')
  if (fullName.length < 2) return { error: 'Укажите имя и фамилию' }
  if (fullName.length > 80) return { error: 'Имя слишком длинное' }
  const phone = normalizeStaffPhone(input.phone)
  if (!phone) return { error: 'Телефон WhatsApp в формате 0700 123 456 или +996 700 123 456' }
  if (passwordRequired || input.password.trim()) {
    const passwordError = validateStaffPassword(input.password)
    if (passwordError) return { error: passwordError }
  }
  return { fullName, phone }
}

/** Понятный текст на нарушение уникальности — пароль или Telegram уже у другого. */
function uniqueError(message: string): string {
  if (message.includes('password_hash')) return 'Такой пароль уже у другого сотрудника — придумайте другой'
  return message
}

export async function createStaffMember(input: StaffInput): Promise<AdminResult> {
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const checked = validate(input, true)
  if ('error' in checked) return { success: false, error: checked.error }

  const { error } = await createAdminClient().from('staff_members').insert({
    full_name: checked.fullName,
    phone: checked.phone,
    password_hash: hashStaffPassword(input.password),
  })
  if (error) return { success: false, error: uniqueError(error.message) }
  revalidatePath('/dashboard/settings')
  return { success: true }
}

export async function updateStaffMember(id: string, input: StaffInput): Promise<AdminResult> {
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const checked = validate(input, false)
  if ('error' in checked) return { success: false, error: checked.error }

  const { error } = await createAdminClient()
    .from('staff_members')
    .update({
      full_name: checked.fullName,
      phone: checked.phone,
      ...(input.password.trim() ? { password_hash: hashStaffPassword(input.password) } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) return { success: false, error: uniqueError(error.message) }
  revalidatePath('/dashboard/settings')
  return { success: true }
}

/**
 * Отключённый сотрудник не войдёт; его открытая смена закрывается, иначе
 * лиды продолжали бы засчитываться человеку, который уже не работает.
 * Историю смен не удаляем — на ней стоит аналитика.
 */
export async function setStaffActive(id: string, active: boolean): Promise<AdminResult> {
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const admin = createAdminClient()
  if (!active) await closeShiftByOwner(id)
  const { error } = await admin
    .from('staff_members')
    .update({ is_active: active, updated_at: new Date().toISOString(), ...(active ? {} : { telegram_id: null }) })
    .eq('id', id)
  if (error) return { success: false, error: error.message }
  revalidatePath('/dashboard/settings')
  return { success: true }
}

export async function saveOwnerWhatsapp(phone: string): Promise<AdminResult> {
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const normalized = phone.trim() ? normalizeStaffPhone(phone) : null
  if (phone.trim() && !normalized) return { success: false, error: 'Номер в формате 0700 123 456 или +996 700 123 456' }

  const admin = createAdminClient()
  const { data } = await admin.from('settings').select('id, extra').limit(1).maybeSingle()
  const row = data as { id: string; extra: Record<string, unknown> | null } | null
  if (!row) return { success: false, error: 'Не найдены настройки компании' }
  const extra = row.extra ?? {}
  const { error } = await admin
    .from('settings')
    .update({ extra: { ...extra, staffShifts: { ...(extra.staffShifts as object | undefined), ownerWhatsapp: normalized } } })
    .eq('id', row.id)
  if (error) return { success: false, error: error.message }
  revalidatePath('/dashboard/settings')
  return { success: true }
}

export async function ownerCloseShift(staffId: string): Promise<AdminResult> {
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  const result = await closeShiftByOwner(staffId)
  revalidatePath('/dashboard/settings')
  return result.ok ? { success: true } : { success: false, error: result.error }
}

export async function ownerDecideRequest(requestId: string, decision: 'approve' | 'reject'): Promise<AdminResult> {
  const guard = await requireOwnerRole()
  if (isFailure(guard)) return guard
  if (decision !== 'approve' && decision !== 'reject') return { success: false, error: 'Неизвестное решение' }
  const result = await decideShiftRequest(requestId, { kind: 'owner' }, decision)
  revalidatePath('/dashboard/settings')
  return result.ok ? { success: true } : { success: false, error: result.error }
}
