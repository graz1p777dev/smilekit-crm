// Смены сотрудников: вход, начало/передача/закрытие смены, подтверждения.
// Один модуль на три входа — страница /smena, Telegram-бот (/staffs) и
// настройки владельца, — чтобы правила не разъехались между ними.
// Только серверный код: пишет admin-клиентом, таблицы смен закрыты RLS.

import { createAdminClient } from '@/lib/supabase/admin'
import {
  afterLoginFailure, attemptsLeft, bishkekTime, canDecide, formatDuration, isRequestExpired,
  loginBlockRemainingMs, planApproval, planShiftStart, SHIFT_REQUEST_TTL_MS,
  type Decider, type LoginGuardState, type ShiftMode, type ShiftRequestKind,
} from './rules'
import { hashStaffPassword, newRequestToken } from './crypto'
import { notifyTelegram, notifyWhatsapp, publicAppUrl, readStaffShiftSettings } from './notify'

type Admin = ReturnType<typeof createAdminClient>

export interface StaffMember {
  id: string
  full_name: string
  phone: string
  telegram_id: number | null
  is_active: boolean
}

export interface OpenShift {
  id: string
  staff_id: string
  mode: ShiftMode
  started_at: string
  staff: StaffMember
}

interface ShiftRequestRow {
  id: string
  requester_id: string
  kind: ShiftRequestKind
  status: string
  token: string
  on_shift_ids: string[]
  created_at: string
}

export type Failure = { ok: false; status: number; error: string }
const fail = (status: number, error: string): Failure => ({ ok: false, status, error })

const STAFF_COLUMNS = 'id, full_name, phone, telegram_id, is_active'

export async function openShifts(admin: Admin = createAdminClient()): Promise<OpenShift[]> {
  const { data, error } = await admin
    .from('staff_shifts')
    .select(`id, staff_id, mode, started_at, staff:staff_members(${STAFF_COLUMNS})`)
    .is('ended_at', null)
    .order('started_at')
  if (error) throw new Error(`staff_shifts: ${error.message}`)
  return (data ?? []) as unknown as OpenShift[]
}

/** Истёкшие запросы помечаем при каждом обращении — отдельный таймер не нужен. */
async function expireStaleRequests(admin: Admin): Promise<void> {
  await admin
    .from('staff_shift_requests')
    .update({ status: 'expired', decided_at: new Date().toISOString() })
    .eq('status', 'pending')
    .lt('created_at', new Date(Date.now() - SHIFT_REQUEST_TTL_MS).toISOString())
}

async function staffById(admin: Admin, id: string): Promise<StaffMember | null> {
  const { data } = await admin.from('staff_members').select(STAFF_COLUMNS).eq('id', id).maybeSingle()
  return (data as StaffMember | null) ?? null
}

export async function staffByTelegram(telegramId: number): Promise<StaffMember | null> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('staff_members')
    .select(STAFF_COLUMNS)
    .eq('telegram_id', telegramId)
    .eq('is_active', true)
    .maybeSingle()
  return (data as StaffMember | null) ?? null
}

export async function activeStaffById(id: string): Promise<StaffMember | null> {
  const staff = await staffById(createAdminClient(), id)
  return staff?.is_active ? staff : null
}

// ─── Вход ────────────────────────────────────────────────────────────────────

export async function loginStaff(
  guardKey: string,
  password: string
): Promise<{ ok: true; staff: StaffMember } | (Failure & { attemptsLeft?: number; retryAfterSeconds?: number })> {
  const admin = createAdminClient()
  const { data: guardRow } = await admin
    .from('staff_login_guard')
    .select('failures, blocked_until')
    .eq('key', guardKey)
    .maybeSingle()
  const guard: LoginGuardState | null = guardRow
    ? { failures: guardRow.failures as number, blockedUntil: guardRow.blocked_until as string | null }
    : null

  const now = Date.now()
  const blockedMs = loginBlockRemainingMs(guard, now)
  if (blockedMs > 0) {
    const retryAfterSeconds = Math.ceil(blockedMs / 1000)
    return {
      ...fail(429, `Слишком много попыток. Попробуйте через ${Math.ceil(retryAfterSeconds / 60)} мин.`),
      retryAfterSeconds,
    }
  }

  const { data: staff } = password.trim()
    ? await admin
        .from('staff_members')
        .select(STAFF_COLUMNS)
        .eq('password_hash', hashStaffPassword(password))
        .eq('is_active', true)
        .maybeSingle()
    : { data: null }

  if (staff) {
    await admin.from('staff_login_guard').delete().eq('key', guardKey)
    return { ok: true, staff: staff as StaffMember }
  }

  const next = afterLoginFailure(guard, now)
  await admin.from('staff_login_guard').upsert({
    key: guardKey,
    failures: next.failures,
    blocked_until: next.blockedUntil,
    updated_at: new Date(now).toISOString(),
  })
  if (next.blockedUntil) {
    return {
      ...fail(429, 'Слишком много попыток. Попробуйте через 5 мин.'),
      retryAfterSeconds: Math.ceil(loginBlockRemainingMs(next, now) / 1000),
    }
  }
  return { ...fail(401, 'Неверный пароль'), attemptsLeft: attemptsLeft(next) }
}

/** Один Telegram — один сотрудник: вход в другой аккаунт снимает старую привязку. */
export async function bindTelegram(staffId: string, telegramId: number): Promise<void> {
  const admin = createAdminClient()
  await admin.from('staff_members').update({ telegram_id: null }).eq('telegram_id', telegramId).neq('id', staffId)
  await admin.from('staff_members').update({ telegram_id: telegramId, updated_at: new Date().toISOString() }).eq('id', staffId)
}

// ─── Состояние ───────────────────────────────────────────────────────────────

export interface StaffState {
  staff: { id: string; fullName: string } | null
  myShift: { mode: ShiftMode; startedAt: string } | null
  onShift: { staffId: string; fullName: string; mode: ShiftMode; startedAt: string }[]
  myPendingRequest: { id: string; kind: ShiftRequestKind; createdAt: string } | null
  awaitingMyDecision: { requestId: string; kind: ShiftRequestKind; requesterName: string; createdAt: string }[]
}

export async function getStaffState(staff: StaffMember | null): Promise<StaffState> {
  const admin = createAdminClient()
  await expireStaleRequests(admin)
  const shifts = await openShifts(admin)
  const onShift = shifts.map((s) => ({
    staffId: s.staff_id, fullName: s.staff.full_name, mode: s.mode, startedAt: s.started_at,
  }))
  if (!staff) return { staff: null, myShift: null, onShift, myPendingRequest: null, awaitingMyDecision: [] }

  const { data: pending } = await admin
    .from('staff_shift_requests')
    .select('id, requester_id, kind, created_at, on_shift_ids, requester:staff_members!staff_shift_requests_requester_id_fkey(full_name)')
    .eq('status', 'pending')
    .order('created_at')
  const rows = (pending ?? []) as unknown as (ShiftRequestRow & { requester: { full_name: string } })[]
  const mine = rows.find((r) => r.requester_id === staff.id)
  const mineShift = shifts.find((s) => s.staff_id === staff.id)

  return {
    staff: { id: staff.id, fullName: staff.full_name },
    myShift: mineShift ? { mode: mineShift.mode, startedAt: mineShift.started_at } : null,
    onShift,
    myPendingRequest: mine ? { id: mine.id, kind: mine.kind, createdAt: mine.created_at } : null,
    awaitingMyDecision: rows
      .filter((r) => canDecide(r.on_shift_ids, r.requester_id, { kind: 'staff', staffId: staff.id }))
      .map((r) => ({ requestId: r.id, kind: r.kind, requesterName: r.requester.full_name, createdAt: r.created_at })),
  }
}

// ─── Действия сотрудника ─────────────────────────────────────────────────────

export type StaffAction = 'take' | 'join' | 'close' | 'cancel_request'
export type ActionOk = { ok: true; result: 'started' | 'requested' | 'closed' | 'cancelled'; message: string }

/**
 * via — откуда нажали. В Telegram сотрудник и так видит ответ на кнопку,
 * дублировать его уведомлением незачем; с веб-страницы — присылаем в Telegram.
 */
export async function performStaffAction(
  staff: StaffMember,
  action: StaffAction,
  via: 'web' | 'telegram'
): Promise<ActionOk | Failure> {
  const admin = createAdminClient()
  await expireStaleRequests(admin)

  if (action === 'close') return closeOwnShift(admin, staff, via)
  if (action === 'cancel_request') {
    const { data } = await admin
      .from('staff_shift_requests')
      .update({ status: 'cancelled', decided_at: new Date().toISOString(), decided_by: staff.full_name })
      .eq('requester_id', staff.id)
      .eq('status', 'pending')
      .select('id')
    if (!data?.length) return fail(404, 'Нет ожидающего запроса')
    return { ok: true, result: 'cancelled', message: 'Запрос отменён' }
  }

  const shifts = await openShifts(admin)
  const plan = planShiftStart(shifts.map((s) => s.staff_id), staff.id)
  if (plan.type === 'already_on_shift') return fail(409, 'Вы уже на смене')

  if (plan.type === 'start') {
    const started = await startShift(admin, staff.id, plan.mode, null)
    if (!started) return fail(409, 'Вы уже на смене')
    const message = `🟢 Смена началась в ${bishkekTime(started)}`
    if (via === 'web') await notifyTelegram(staff.telegram_id, message)
    return { ok: true, result: 'started', message }
  }

  const token = newRequestToken()
  const { data: request, error } = await admin
    .from('staff_shift_requests')
    .insert({ requester_id: staff.id, kind: action, token, on_shift_ids: plan.onShiftIds })
    .select('id')
    .single()
  if (error || !request) {
    // Уникальный индекс: один ожидающий запрос на человека.
    if (error?.code === '23505') return fail(409, 'Запрос уже отправлен — ждём подтверждения')
    return fail(500, 'Не удалось отправить запрос')
  }

  const holders = shifts.map((s) => s.staff)
  const names = holders.map((h) => h.full_name).join(', ')
  await notifyShiftRequest(staff, action, holders, (request as { id: string }).id, token)

  const what = action === 'take' ? 'Смена начнётся' : 'Работа вместе начнётся'
  return {
    ok: true,
    result: 'requested',
    message: `Запрос отправлен: ${names}. ${what} после подтверждения.`,
  }
}

async function startShift(admin: Admin, staffId: string, mode: ShiftMode, requestId: string | null): Promise<string | null> {
  const { data, error } = await admin
    .from('staff_shifts')
    .insert({ staff_id: staffId, mode, request_id: requestId })
    .select('started_at')
    .single()
  if (error) {
    if (error.code === '23505') return null
    throw new Error(`staff_shifts insert: ${error.message}`)
  }
  return (data as { started_at: string }).started_at
}

async function endShifts(
  admin: Admin,
  staffIds: string[],
  reason: 'closed' | 'replaced' | 'owner'
): Promise<{ staff_id: string; started_at: string; ended_at: string }[]> {
  if (!staffIds.length) return []
  const { data, error } = await admin
    .from('staff_shifts')
    .update({ ended_at: new Date().toISOString(), ended_reason: reason })
    .in('staff_id', staffIds)
    .is('ended_at', null)
    .select('staff_id, started_at, ended_at')
  if (error) throw new Error(`staff_shifts close: ${error.message}`)
  return (data ?? []) as { staff_id: string; started_at: string; ended_at: string }[]
}

async function closeOwnShift(admin: Admin, staff: StaffMember, via: 'web' | 'telegram'): Promise<ActionOk | Failure> {
  const [closed] = await endShifts(admin, [staff.id], 'closed')
  if (!closed) return fail(404, 'Вы сейчас не на смене')
  const worked = formatDuration(new Date(closed.ended_at).getTime() - new Date(closed.started_at).getTime())
  const message = `🔴 Смена закрыта в ${bishkekTime(closed.ended_at)}. Отработано: ${worked}`
  if (via === 'web') await notifyTelegram(staff.telegram_id, message)
  return { ok: true, result: 'closed', message }
}

async function notifyShiftRequest(
  requester: StaffMember,
  kind: ShiftRequestKind,
  holders: StaffMember[],
  requestId: string,
  token: string
): Promise<void> {
  const link = `${publicAppUrl()}/smena/confirm/${token}`
  const settings = await readStaffShiftSettings()
  const names = holders.map((h) => h.full_name).join(', ')
  const askHolder = kind === 'take' ? 'забрать вашу смену' : 'работать вместе с вами'
  const askOwner = kind === 'take' ? `забрать смену у: ${names}` : `работать вместе с: ${names}`

  await Promise.allSettled([
    ...holders.flatMap((holder) => [
      notifyWhatsapp(
        holder.phone,
        `SmileKit · смены\n\n${requester.full_name} просит ${askHolder}.\n\n` +
          `Подтвердить или отклонить:\n${link}\n\nСсылка действует 30 минут.`
      ),
      notifyTelegram(holder.telegram_id, `🔔 ${requester.full_name} просит ${askHolder}.`, [
        { text: '✅ Подтвердить', callbackData: `staff:approve:${requestId}` },
        { text: '❌ Отклонить', callbackData: `staff:reject:${requestId}` },
      ]),
    ]),
    notifyWhatsapp(
      settings.ownerWhatsapp,
      `SmileKit · смены\n\n${requester.full_name} просит ${askOwner}.\n\n` +
        `Подтвердить или отклонить:\n${link}\n\nСсылка действует 30 минут.`
    ),
  ])
}

// ─── Подтверждение ───────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  approved: 'подтверждён', rejected: 'отклонён', cancelled: 'отменён', expired: 'истёк',
}

export interface RequestView {
  id: string
  kind: ShiftRequestKind
  status: string
  createdAt: string
  requesterName: string
  holderNames: string[]
}

export async function findRequestByToken(token: string): Promise<RequestView | null> {
  const admin = createAdminClient()
  await expireStaleRequests(admin)
  const { data } = await admin
    .from('staff_shift_requests')
    .select('id, kind, status, created_at, on_shift_ids, requester:staff_members!staff_shift_requests_requester_id_fkey(full_name)')
    .eq('token', token)
    .maybeSingle()
  if (!data) return null
  const row = data as unknown as ShiftRequestRow & { requester: { full_name: string } }
  const { data: holders } = row.on_shift_ids.length
    ? await admin.from('staff_members').select('full_name').in('id', row.on_shift_ids)
    : { data: [] }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    requesterName: row.requester.full_name,
    holderNames: ((holders ?? []) as { full_name: string }[]).map((h) => h.full_name),
  }
}

export async function decideShiftRequest(
  requestId: string,
  decider: Decider,
  decision: 'approve' | 'reject'
): Promise<{ ok: true; message: string } | Failure> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('staff_shift_requests')
    .select('id, requester_id, kind, status, token, on_shift_ids, created_at')
    .eq('id', requestId)
    .maybeSingle()
  const request = data as ShiftRequestRow | null
  if (!request) return fail(404, 'Запрос не найден')
  if (request.status === 'pending' && isRequestExpired(request.created_at, Date.now())) {
    await expireStaleRequests(admin)
    return fail(410, 'Запрос истёк — прошло больше 30 минут')
  }
  if (request.status !== 'pending') return fail(409, `Запрос уже ${STATUS_LABEL[request.status] ?? 'обработан'}`)
  if (!canDecide(request.on_shift_ids, request.requester_id, decider)) {
    return fail(403, 'Подтвердить может только тот, кто на смене, или владелец')
  }

  const deciderName =
    decider.kind === 'owner' ? 'владелец'
      : decider.kind === 'link' ? 'по ссылке из WhatsApp'
        : (await staffById(admin, decider.staffId))?.full_name ?? 'сотрудник'

  // Статус меняем условно (только из pending): два одновременных нажатия
  // «Подтвердить» не начнут смену дважды.
  const { data: claimed } = await admin
    .from('staff_shift_requests')
    .update({
      status: decision === 'approve' ? 'approved' : 'rejected',
      decided_at: new Date().toISOString(),
      decided_by: deciderName,
    })
    .eq('id', request.id)
    .eq('status', 'pending')
    .select('id')
  if (!claimed?.length) return fail(409, 'Запрос уже обработан')

  const requester = await staffById(admin, request.requester_id)
  if (!requester) return fail(404, 'Сотрудник не найден')

  if (decision === 'reject') {
    await notifyTelegram(requester.telegram_id, `❌ Запрос отклонён (${deciderName}).`)
    return { ok: true, message: `Запрос ${requester.full_name} отклонён` }
  }

  const shifts = await openShifts(admin)
  const plan = planApproval(request.kind, shifts.map((s) => s.staff_id), requester.id)
  const closed = await endShifts(admin, plan.close, 'replaced')
  const startedAt = plan.startMode ? await startShift(admin, requester.id, plan.startMode, request.id) : null
  const at = bishkekTime(startedAt ?? new Date())

  const stayed = shifts.filter((s) => s.staff_id !== requester.id && !plan.close.includes(s.staff_id))
  const notices: Promise<void>[] = []
  if (request.kind === 'take') {
    notices.push(notifyTelegram(requester.telegram_id, `✅ Запрос подтверждён (${deciderName}). Ваша смена началась в ${at}.`))
    for (const row of closed) {
      const holder = shifts.find((s) => s.staff_id === row.staff_id)?.staff
      const worked = formatDuration(new Date(row.ended_at).getTime() - new Date(row.started_at).getTime())
      notices.push(notifyTelegram(
        holder?.telegram_id ?? null,
        `🔁 Смену принимает ${requester.full_name}. Ваша смена закрыта в ${bishkekTime(row.ended_at)}. Отработано: ${worked}`
      ))
    }
  } else {
    const partners = stayed.map((s) => s.staff.full_name).join(', ')
    notices.push(notifyTelegram(
      requester.telegram_id,
      partners
        ? `✅ Запрос подтверждён (${deciderName}). Вы работаете вместе с: ${partners} с ${at}.`
        : `✅ Запрос подтверждён (${deciderName}). На смене больше никого — ваша смена началась в ${at}.`
    ))
    for (const s of stayed) {
      notices.push(notifyTelegram(s.staff.telegram_id, `🤝 ${requester.full_name} работает вместе с вами с ${at}.`))
    }
  }
  await Promise.allSettled(notices)

  return {
    ok: true,
    message: request.kind === 'take'
      ? `Подтверждено: смену принимает ${requester.full_name}`
      : `Подтверждено: ${requester.full_name} работает вместе`,
  }
}

/** Владелец закрывает смену за сотрудника — например, тот забыл нажать «Закрыть». */
export async function closeShiftByOwner(staffId: string): Promise<{ ok: true } | Failure> {
  const admin = createAdminClient()
  const [closed] = await endShifts(admin, [staffId], 'owner')
  if (!closed) return fail(404, 'Сотрудник уже не на смене')
  const staff = await staffById(admin, staffId)
  await notifyTelegram(staff?.telegram_id ?? null, `🔴 Владелец закрыл вашу смену в ${bishkekTime(closed.ended_at)}.`)
  return { ok: true }
}
