'use client'

import { Clock, GripVertical, MapPin, Phone } from 'lucide-react'
import { formatMoney, getInitials } from '@/lib/formatters'
import { cn } from '@/lib/utils'
import type { Deal, DealEmployee } from '@/types'
import { DEAL_SOURCE, formatStageAge } from './deal-config'

interface Props {
  deal: Deal
  employees: Map<string, DealEmployee>
  stageColor: string
  dragging: boolean
  /** Клиент под оформлением заказа или уже оформил — подпись и красная подсветка. */
  urgentLabel: string | null
  onDragStart: () => void
  onDragEnd: () => void
  onClick: () => void
}

function Avatar({ emp }: { emp: DealEmployee }) {
  if (emp.avatar_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={emp.avatar_url}
        alt={emp.name}
        title={emp.name}
        className="h-6 w-6 rounded-full object-cover ring-2 ring-white"
      />
    )
  }
  return (
    <div
      title={emp.name}
      className="flex h-6 w-6 items-center justify-center rounded-full text-white ring-2 ring-white brand-gradient"
      style={{ fontSize: 10, fontWeight: 600 }}
    >
      {getInitials(emp.name)}
    </div>
  )
}

export default function DealCard({
  deal,
  employees,
  stageColor,
  dragging,
  urgentLabel,
  onDragStart,
  onDragEnd,
  onClick,
}: Props) {
  // «Оформлено» — успех, зелёным; «Оформляет» — нужно внимание менеджера,
  // янтарным. Красный в CRM — только сигнал ошибки (CLAUDE.md).
  const tone = urgentLabel === 'Оформлено'
    ? { line: '#047857', soft: '#ecfdf5', badge: '#047857' }
    : { line: '#b45309', soft: '#fffbeb', badge: '#b45309' }
  const source = DEAL_SOURCE[deal.source]
  const SourceIcon = source.icon
  const responsible = deal.responsible_employee_id
    ? employees.get(deal.responsible_employee_id)
    : undefined
  const customer = deal.customer_name || deal.customer_username || deal.customer_phone

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', deal.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={cn(
        'group relative cursor-pointer select-none rounded-xl border bg-white p-3 shadow-sm',
        'transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md',
        urgentLabel ? '' : 'border-gray-100 hover:border-gray-200',
        dragging && 'opacity-40 rotate-[1.5deg]'
      )}
      style={{
        borderLeft: `3px solid ${stageColor}`,
        ...(urgentLabel && { borderColor: tone.line, background: tone.soft, boxShadow: `0 0 0 1px ${tone.line}` }),
      }}
    >
      <div
        className="absolute right-1.5 top-2.5 text-gray-300 opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden
      >
        <GripVertical size={14} />
      </div>

      {urgentLabel && (
        <span
          className="mb-1.5 inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white"
          style={{ background: tone.badge }}
        >
          {urgentLabel}
        </span>
      )}

      <p className="pr-4 text-[13px] font-semibold leading-snug text-gray-800 line-clamp-2">
        {deal.title}
      </p>

      {customer && customer !== deal.title && (
        <p className="mt-1 text-[12px] leading-snug text-gray-400 line-clamp-1">{customer}</p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
          style={{ color: source.color, background: source.bg }}
        >
          <SourceIcon size={11} />
          {source.label}
        </span>

        {deal.amount !== null && (
          <span className="inline-flex items-center rounded-md bg-[#f1ebfa] px-1.5 py-0.5 text-[10px] font-semibold text-[#5115a4]">
            {formatMoney(deal.amount, deal.currency)}
          </span>
        )}

        {deal.customer_phone && (
          <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
            <Phone size={10} />
            {deal.customer_phone}
          </span>
        )}

        {deal.city && (
          <span className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
            <MapPin size={10} />
            {deal.city}
          </span>
        )}
      </div>

      <div className="mt-2.5 flex items-center justify-between">
        <span
          className="inline-flex items-center gap-1 text-[10px] text-gray-400"
          title="Время в текущем этапе"
        >
          <Clock size={12} />
          {formatStageAge(deal.stage_changed_at)}
        </span>
        {responsible ? (
          <Avatar emp={responsible} />
        ) : (
          <span className="text-[10px] text-gray-300">без ответственного</span>
        )}
      </div>
    </div>
  )
}
