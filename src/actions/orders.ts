'use server'

// Заказы (038_orders.sql). Приходят из Telegram-бота через
// POST /api/internal/orders; здесь — только то, что делает менеджер:
// читает список, двигает статус, берёт заказ на себя и дописывает заметку.

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { closeDealForOrder } from '@/lib/deals/close-from-order'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { DealEmployee, DealViewer, Order, OrderDealRef, OrderStatus } from '@/types'

export type OrderActionResult<T = undefined> =
  | { success: true; data?: T }
  | { success: false; error: string }

const ORDER_STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'] as const

async function getViewer(): Promise<DealViewer | null> {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null

  const { data } = await supabase
    .from('employees')
    .select('id, role, name')
    .eq('user_id', session.user.id)
    .is('deleted_at', null)
    .maybeSingle()

  return (data as DealViewer | null) ?? null
}

// ─── Данные страницы ─────────────────────────────────────────────────────────

export interface OrdersData {
  orders: Order[]
  employees: DealEmployee[]
  /** Сделки, к которым привязаны заказы, — чтобы показать связь в карточке. */
  deals: Record<string, OrderDealRef>
  me: DealViewer | null
}

export async function getOrdersData(): Promise<OrdersData> {
  const me = await getViewer()
  if (!me) return { orders: [], employees: [], deals: {}, me: null }

  const supabase = await createClient()
  const admin = createAdminClient()

  // orders — через RLS-клиент: какие заказы видны, решает БД.
  // employees — через admin: имена нужны для пикера ответственного.
  const [{ data: rows }, { data: emps }] = await Promise.all([
    supabase
      .from('orders')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(500),
    admin
      .from('employees')
      .select('id, name, avatar_url')
      .is('deleted_at', null)
      .order('name'),
  ])

  const orders = (rows ?? []) as Order[]
  const dealIds = [...new Set(orders.map(o => o.deal_id).filter((id): id is string => !!id))]

  const deals: Record<string, OrderDealRef> = {}
  if (dealIds.length > 0) {
    const { data: dealRows } = await supabase
      .from('deals')
      .select('id, title, deal_stages(name)')
      .in('id', dealIds)
    for (const row of (dealRows ?? []) as unknown[]) {
      const deal = row as { id: string; title: string; deal_stages: { name: string } | null }
      deals[deal.id] = {
        id: deal.id,
        title: deal.title,
        stage_name: deal.deal_stages?.name ?? null,
      }
    }
  }

  return { orders, employees: (emps ?? []) as DealEmployee[], deals, me }
}

// ─── Мутации ─────────────────────────────────────────────────────────────────

const StatusSchema = z.enum(ORDER_STATUSES)

export async function updateOrderStatus(
  id: string,
  status: OrderStatus
): Promise<OrderActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  const parsed = StatusSchema.safeParse(status)
  if (!parsed.success) return { success: false, error: 'Неизвестный статус' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('orders')
    .update({ status: parsed.data })
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')

  if (error) return { success: false, error: error.message }
  if (!data || data.length === 0) return { success: false, error: 'Заказ недоступен' }

  // Доставленный заказ закрывает сделку как выигранную, отменённый — как
  // проигранную. Бот довести сделку до этих этапов не может: отказ клиента
  // из переписки надёжно не читается, а судьба заказа известна точно.
  await closeDealForOrder(id, parsed.data)

  revalidatePath('/dashboard/orders')
  revalidatePath('/dashboard/deals')
  return { success: true }
}

export async function assignOrder(
  id: string,
  employeeId: string | null
): Promise<OrderActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  if (employeeId !== null && !z.string().uuid().safeParse(employeeId).success) {
    return { success: false, error: 'Неверный сотрудник' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('orders')
    .update({ responsible_employee_id: employeeId })
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')

  if (error) return { success: false, error: error.message }
  if (!data || data.length === 0) return { success: false, error: 'Заказ недоступен' }

  revalidatePath('/dashboard/orders')
  return { success: true }
}

export async function updateOrderNote(id: string, note: string): Promise<OrderActionResult> {
  const me = await getViewer()
  if (!me) return { success: false, error: 'Нет авторизации' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('orders')
    .update({ note: note.trim().slice(0, 4000) || null })
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')

  if (error) return { success: false, error: error.message }
  if (!data || data.length === 0) return { success: false, error: 'Заказ недоступен' }

  revalidatePath('/dashboard/orders')
  return { success: true }
}
