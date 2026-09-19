'use client'

// Карточка заказа. Показывает всё, что удалось собрать боту, и даёт менеджеру
// три действия: сменить статус, назначить ответственного, дописать заметку.
// Заметка менеджера и summary бота — разные поля: пуш от бота не должен
// затирать то, что менеджер выяснил в разговоре.

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { Handshake, X } from 'lucide-react'
import { assignOrder, updateOrderNote, updateOrderStatus } from '@/actions/orders'
import { ORDER_STATUS, ORDER_STATUS_ORDER, formatOrderDate, formatOrderMoney } from './order-config'
import type { DealEmployee, Order, OrderDealRef, OrderStatus } from '@/types'

export default function OrderDetail({
  order,
  employees,
  deal,
  onClose,
  onPatch,
}: {
  order: Order
  employees: DealEmployee[]
  deal: OrderDealRef | null
  onClose: () => void
  onPatch: (patch: Partial<Order> & { id: string }) => void
}) {
  const [note, setNote] = useState(order.note ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [isPending, startTransition] = useTransition()

  function changeStatus(next: OrderStatus) {
    if (next === order.status) return
    setError(null)
    onPatch({ id: order.id, status: next })
    startTransition(async () => {
      const result = await updateOrderStatus(order.id, next)
      if (!result.success) {
        setError(result.error)
        onPatch({ id: order.id, status: order.status })
      }
    })
  }

  function changeResponsible(employeeId: string | null) {
    setError(null)
    onPatch({ id: order.id, responsible_employee_id: employeeId })
    startTransition(async () => {
      const result = await assignOrder(order.id, employeeId)
      if (!result.success) {
        setError(result.error)
        onPatch({ id: order.id, responsible_employee_id: order.responsible_employee_id })
      }
    })
  }

  function saveNote() {
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const result = await updateOrderNote(order.id, note)
      if (result.success) {
        onPatch({ id: order.id, note: note.trim() || null })
        setSaved(true)
      } else {
        setError(result.error)
      }
    })
  }

  const who =
    order.customer_name || order.customer_username || order.customer_phone || 'Клиент без имени'

  // Ссылка на чек — тем же маркером, что и в переписке сделки (см.
  // MEDIA_MARKER в src/actions/deals.ts): отдельной колонки под вложения
  // в orders нет, а плодить миграцию под одну ссылку избыточно.
  const receiptMatch = order.summary?.match(/\n\[media\](\S+)$/)
  const receiptUrl = receiptMatch?.[1] ?? null
  const summaryText = receiptMatch ? order.summary!.slice(0, receiptMatch.index) : order.summary

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 md:p-8"
      style={{ background: 'rgba(23, 16, 42, 0.35)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-3xl p-5 md:p-6"
        style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold" style={{ color: 'var(--ink)' }}>{who}</h2>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-3)' }}>
              Заказ от {formatOrderDate(order.created_at)} ·{' '}
              {order.source === 'telegram_bot'
                ? 'из Telegram-бота'
                : order.summary?.includes('(WhatsApp)')
                  ? 'из WhatsApp-бота'
                  : 'заведён вручную'}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="flex size-10 shrink-0 items-center justify-center rounded-xl md:size-8"
            style={{ border: '1px solid var(--line)', color: 'var(--ink-3)' }}
          >
            <X size={15} />
          </button>
        </div>

        {/* Статус */}
        <p className="mt-5 text-xs font-semibold" style={{ color: 'var(--ink-3)' }}>Статус</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {ORDER_STATUS_ORDER.map(value => {
            const meta = ORDER_STATUS[value]
            const active = value === order.status
            return (
              <button
                key={value}
                data-order-status={value}
                disabled={isPending}
                onClick={() => changeStatus(value)}
                className="min-h-9 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 md:min-h-0"
                style={{
                  background: active ? meta.bg : 'var(--surface)',
                  color: active ? meta.color : 'var(--ink-2)',
                  border: `1px solid ${active ? meta.color : 'var(--line)'}`,
                }}
              >
                {meta.label}
              </button>
            )
          })}
        </div>

        {/* Что собрал бот */}
        <div
          className="mt-5 grid gap-x-4 gap-y-3 rounded-2xl p-4 sm:grid-cols-2"
          style={{ background: 'var(--surface-2)' }}
        >
          <Field label="Количество" value={order.quantity !== null ? `${order.quantity} кор.` : null} />
          <Field
            label="Сумма"
            value={
              order.total_amount === null
                ? null
                : formatOrderMoney(Number(order.total_amount), order.currency)
            }
          />
          <Field
            label="Цена за коробку"
            value={
              order.unit_price === null
                ? null
                : formatOrderMoney(Number(order.unit_price), order.currency)
            }
          />
          <Field label="Город" value={order.city} />
          <Field label="Телефон" value={order.customer_phone} />
          <Field
            label="Telegram"
            value={order.customer_username ?? (order.telegram_chat_id !== null ? `chat ${order.telegram_chat_id}` : null)}
          />
        </div>

        {order.summary && (
          <>
            <p className="mt-5 text-xs font-semibold" style={{ color: 'var(--ink-3)' }}>
              Заказ словами бота
            </p>
            <p
              className="mt-2 whitespace-pre-wrap rounded-2xl p-3.5 text-sm leading-relaxed"
              style={{ background: 'var(--brand-soft)', color: 'var(--ink-2)' }}
            >
              {summaryText}
            </p>
            {receiptUrl && (
              <a
                href={receiptUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium underline underline-offset-2"
                style={{ color: 'var(--brand-ink)' }}
              >
                📎 Открыть чек
              </a>
            )}
          </>
        )}

        {deal && (
          <Link
            href={`/dashboard/deals?deal=${deal.id}`}
            className="mt-4 flex items-center gap-2.5 rounded-2xl px-3.5 py-3 text-sm"
            style={{ border: '1px solid var(--line)', color: 'var(--ink-2)' }}
          >
            <Handshake size={16} style={{ color: 'var(--brand-ink)' }} />
            <span className="min-w-0 flex-1 truncate">
              Сделка: {deal.title}
              {deal.stage_name ? ` · ${deal.stage_name}` : ''}
            </span>
            <span className="shrink-0 text-xs" style={{ color: 'var(--brand-ink)' }}>Написать →</span>
          </Link>
        )}

        {/* Ответственный */}
        <p className="mt-5 text-xs font-semibold" style={{ color: 'var(--ink-3)' }}>Ответственный</p>
        <select
          data-order-responsible
          disabled={isPending}
          value={order.responsible_employee_id ?? ''}
          onChange={e => changeResponsible(e.target.value || null)}
          className="mt-2 w-full rounded-xl px-3 py-2 text-sm outline-none disabled:opacity-60"
          style={{ border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)' }}
        >
          <option value="">Не назначен</option>
          {employees.map(employee => (
            <option key={employee.id} value={employee.id}>{employee.name}</option>
          ))}
        </select>

        {/* Заметка менеджера */}
        <p className="mt-5 text-xs font-semibold" style={{ color: 'var(--ink-3)' }}>Заметка менеджера</p>
        <textarea
          value={note}
          onChange={e => { setNote(e.target.value); setSaved(false) }}
          rows={3}
          placeholder="Что выяснили по телефону: адрес, время доставки, оплата."
          className="mt-2 w-full resize-none rounded-xl px-3 py-2 text-sm outline-none"
          style={{ border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)' }}
        />

        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={saveNote}
            disabled={isPending}
            className="rounded-xl px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-60"
            style={{ background: 'var(--brand)' }}
          >
            Сохранить заметку
          </button>
          {saved && !error && (
            <span className="text-xs" style={{ color: 'var(--ok)' }}>Сохранено</span>
          )}
          {error && <span className="text-xs" style={{ color: 'var(--bad)' }}>{error}</span>}
        </div>
      </div>
    </div>
  )
}

/** Неизвестное поле показываем прочерком: бот его не выдумывает. */
function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-[11px]" style={{ color: 'var(--ink-3)' }}>{label}</p>
      <p
        className="mt-0.5 text-sm font-medium"
        style={{ color: value ? 'var(--ink)' : 'var(--ink-3)' }}
      >
        {value ?? '—'}
      </p>
    </div>
  )
}
