'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { Plus, Search } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { formatMoney } from '@/lib/formatters'
import type { Deal, DealEmployee, DealStage, DealViewer } from '@/types'
import { getDealsData, moveDeal } from '@/actions/deals'
import { DEAL_SOURCE, stageSoft } from './deal-config'
import { DEAL_SORTS, DEAL_VIEWS, sortDeals, type DealSort, type DealView } from './deal-view'
import DealCard from './DealCard'
// Карточка сделки (700 строк с перепиской, покупками и формой) нужна только
// по клику — грузим её код отдельным куском, а не в составе доски.
const DealModal = dynamic(() => import('./DealModal'))
import { BotToggle } from './BotToggle'

interface Props {
  initialStages: DealStage[]
  initialDeals: Deal[]
  employees: DealEmployee[]
  me: DealViewer
  /** Открыть карточку сразу при загрузке — переход со страницы «Заказы». */
  initialOpenDealId?: string | null
}

interface ModalState {
  open: boolean
  deal: Deal | null
  isNew: boolean
  stageId: string
}

/**
 * Сколько карточек колонка рисует сразу. В первом этапе воронки лежит почти
 * вся база (сотни сделок), и доска раньше вставляла в DOM их все — браузер
 * собирал больше тысячи карточек на каждый рендер, из-за чего страница
 * заметно подвисала при открытии, вводе в поиск и любом перетаскивании.
 * Остальное догружается кнопкой «Показать ещё» — итог и счётчик колонки
 * при этом всегда считаются по ПОЛНОМУ списку, а не по видимой части.
 */
const COLUMN_PAGE = 25

/** Итог колонки: сумма по валютам, поэтому не одно число, а несколько. */
function columnTotals(deals: Deal[]): string[] {
  const byCurrency = new Map<string, number>()
  for (const d of deals) {
    if (d.amount === null) continue
    byCurrency.set(d.currency, (byCurrency.get(d.currency) ?? 0) + Number(d.amount))
  }
  return [...byCurrency.entries()].map(([currency, sum]) => formatMoney(sum, currency))
}

export default function DealsBoard({ initialStages, initialDeals, employees, me, initialOpenDealId }: Props) {
  const [deals, setDeals] = useState<Deal[]>(initialDeals)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [employeeFilter, setEmployeeFilter] = useState<string>('all')
  const [modal, setModal] = useState<ModalState>({
    open: false, deal: null, isNew: false, stageId: '',
  })
  const [shownPerStage, setShownPerStage] = useState<Record<string, number>>({})
  // Вкладки и сортировка — приём с доски DemiResults: на тысяче сделок
  // закрытые только мешают, а порядок «что дольше всех висит» важнее
  // порядка создания.
  const [view, setView] = useState<DealView>('active')
  const [sort, setSort] = useState<DealSort>('stage-asc')
  const [sourceFilter, setSourceFilter] = useState<string>('all')

  // Переход со страницы «Заказы» — открываем карточку сразу, не дожидаясь
  // клика по колонке. Зависимость от initialOpenDealId обязательна: при
  // клиентской навигации (Link) на тот же /dashboard/deals с новым ?deal=
  // React переиспользует уже смонтированный DealsBoard, а не пересоздаёт
  // его — эффект с пустым []-массивом зависимостей срабатывал только на
  // первый заход и не реагировал на смену параметра в URL при последующих
  // переходах (кнопка «Написать →» из заказа работала только после
  // жёсткой перезагрузки страницы, где компонент действительно монтируется
  // заново).
  useEffect(() => {
    if (!initialOpenDealId) return
    const target = initialDeals.find((d) => d.id === initialOpenDealId)
    if (target) setModal({ open: true, deal: target, isNew: false, stageId: target.stage_id })
  }, [initialOpenDealId, initialDeals])

  const stages = initialStages
  const defaultStageId = useMemo(
    () => stages.find((s) => s.is_default)?.id ?? stages[0]?.id ?? '',
    [stages]
  )

  // Realtime-подписка живёт вне рендера, а знать о текущем перетаскивании ей
  // нужно — держим id и в состоянии (для отрисовки), и в ref (для колбэка).
  const dragIdRef = useRef<string | null>(null)
  const beginDrag = (id: string) => {
    dragIdRef.current = id
    setDragId(id)
  }

  // Показываем в фильтре только те источники, что реально есть в сделках,
  // — пустые варианты в списке только мешают.
  const sources = useMemo(
    () => [...new Set(deals.map((d) => d.source))].sort(),
    [deals]
  )

  const employeeMap = useMemo(() => {
    const m = new Map<string, DealEmployee>()
    for (const e of employees) m.set(e.id, e)
    return m
  }, [employees])

  const refresh = useCallback(async () => {
    const data = await getDealsData()
    setDeals(data.deals)
  }, [])

  // Сверки с внешними системами больше нет: канал один — Green API, и
  // сделки заводит он сам на входящем сообщении.

  // ─── Realtime ──────────────────────────────────────────────────────────────
  // Раньше любое изменение одной сделки запускало refresh() — то есть
  // повторное чтение ВСЕХ сделок (1000+ строк) ради одной строки. При живом
  // потоке вебхуков amoCRM это молотило постоянно и подвешивало доску.
  // Теперь строку из payload применяем на месте, а полный перезапрос
  // оставлен запасным вариантом — когда в событии нет самой строки.
  useEffect(() => {
    const supabase = createClient()
    let timer: ReturnType<typeof setTimeout> | null = null
    const channel = supabase
      .channel('deals-board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deals' }, (payload) => {
        if (dragIdRef.current) return // не мешаем текущему перетаскиванию

        if (payload.eventType === 'DELETE') {
          const removedId = (payload.old as { id?: string } | null)?.id
          if (removedId) {
            setDeals((prev) => prev.filter((d) => d.id !== removedId))
            return
          }
        } else {
          const row = payload.new as Deal | null
          if (row?.id) {
            setDeals((prev) => {
              const index = prev.findIndex((d) => d.id === row.id)
              // Мягкое удаление приезжает как UPDATE — убираем с доски.
              if ((row as Deal & { deleted_at?: string | null }).deleted_at) {
                return index === -1 ? prev : prev.filter((d) => d.id !== row.id)
              }
              if (index === -1) return [row, ...prev]
              const next = [...prev]
              next[index] = row
              return next
            })
            return
          }
        }

        // Строки в событии нет — только тогда перечитываем доску целиком.
        if (timer) clearTimeout(timer)
        timer = setTimeout(refresh, 400)
      })
      .subscribe()
    return () => {
      if (timer) clearTimeout(timer)
      supabase.removeChannel(channel)
    }
  }, [refresh])

  // Сделки уже переданы в оформление заказа — этот же этап отмечает
  // ACTION_STAGE_NAME['order'] в src/lib/deals/advance-stage.ts, здесь имя
  // этапа используется тем же способом, чтобы не заводить отдельный флаг.
  const orderStageId = useMemo(
    () => stages.find((s) => s.name === 'Передан менеджеру')?.id ?? null,
    [stages]
  )

  // ─── Фильтрация и раскладка по колонкам ────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return deals.filter((d) => {
      if (view === 'active' && d.status !== 'open') return false
      if (view === 'won' && d.status !== 'won') return false
      if (view === 'lost' && d.status !== 'lost') return false
      if (sourceFilter !== 'all' && d.source !== sourceFilter) return false
      if (employeeFilter !== 'all') {
        if (employeeFilter === 'none') {
          if (d.responsible_employee_id) return false
        } else if (d.responsible_employee_id !== employeeFilter) {
          return false
        }
      }
      if (!q) return true
      return `${d.title} ${d.customer_name ?? ''} ${d.customer_phone ?? ''} ${d.customer_username ?? ''} ${d.city ?? ''} ${d.address ?? ''}`
        .toLowerCase()
        .includes(q)
    })
  }, [deals, search, employeeFilter, view, sourceFilter])

  const columns = useMemo(() => {
    const map = new Map<string, Deal[]>()
    for (const s of stages) map.set(s.id, [])
    for (const d of filtered) map.get(d.stage_id)?.push(d)
    for (const list of map.values()) sortDeals(list, sort)
    return map
  }, [filtered, stages, sort])

  // ─── Перетаскивание ────────────────────────────────────────────────────────
  const endDrag = () => {
    dragIdRef.current = null
    setDragId(null)
    setDragOverStage(null)
  }

  const performDrop = async (toStageId: string) => {
    const id = dragId
    endDrag()
    if (!id) return

    const moving = deals.find((d) => d.id === id)
    if (!moving || moving.stage_id === toStageId) return

    const snapshot = deals
    const movedAt = new Date().toISOString()
    setDeals((prev) =>
      prev.map((d) => (d.id === id ? { ...d, stage_id: toStageId, stage_changed_at: movedAt } : d))
    )

    const res = await moveDeal(id, toStageId)
    if (!res.success) {
      toast.error(res.error)
      setDeals(snapshot) // откат
    }
  }

  const openNew = (stageId: string) =>
    setModal({ open: true, deal: null, isNew: true, stageId })
  const openEdit = (deal: Deal) =>
    setModal({ open: true, deal, isNew: false, stageId: deal.stage_id })
  const closeModal = () => setModal((m) => ({ ...m, open: false }))

  return (
    <div className="flex h-[calc(100vh-52px)] h-[calc(100dvh-52px)] flex-col">
      {/* Заголовок и панель. На телефоне фильтры — одна полоса с прокруткой
          вбок, поиск и «Создать» — отдельной строкой: иначе панель занимала
          весь экран и доски не было видно. */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6 md:py-4">
        <div>
          <p className="kicker">Воронка продаж</p>
          <h1 className="block-title">Сделки</h1>
          <span className="span-rule hidden md:block" aria-hidden />
          <p className="mt-1.5 text-[13px] text-gray-400">
            {me.role === 'owner' || me.role === 'rop'
              ? `Все сделки магазина · ${filtered.length} из ${deals.length}`
              : `Ваши сделки · ${filtered.length} из ${deals.length}`}
          </p>
        </div>

        <div className="flex w-full min-w-0 flex-col gap-2 md:w-auto md:flex-row md:flex-wrap md:items-center">
          <div className="-mx-4 flex items-center gap-2 overflow-x-auto overscroll-x-contain px-4 scroll-hidden md:mx-0 md:flex-wrap md:overflow-visible md:px-0 [&>*]:shrink-0">
          <BotToggle />

          {/* В работе / Успешные / Отказ */}
          <div className="flex gap-0.5 rounded-xl border border-gray-200 bg-white/80 p-0.5">
            {DEAL_VIEWS.map((item) => (
              <button
                key={item.key}
                onClick={() => { setView(item.key); setShownPerStage({}) }}
                className={cn(
                  'min-h-9 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors md:min-h-0',
                  view === item.key ? 'text-white brand-gradient' : 'text-gray-500 hover:text-gray-700'
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as DealSort)}
            className="h-10 rounded-xl border border-gray-200 bg-white/80 px-3 text-base text-gray-600 outline-none transition-colors focus:border-gray-300 md:h-9 md:text-[13px]"
            title="Порядок карточек в колонке"
          >
            {DEAL_SORTS.map((item) => (
              <option key={item.key} value={item.key}>{item.label}</option>
            ))}
          </select>

          <select
            value={sourceFilter}
            onChange={(e) => { setSourceFilter(e.target.value); setShownPerStage({}) }}
            className="h-10 rounded-xl border border-gray-200 bg-white/80 px-3 text-base text-gray-600 outline-none transition-colors focus:border-gray-300 md:h-9 md:text-[13px]"
            title="Фильтр по источнику"
          >
            <option value="all">Все источники</option>
            {sources.map((item) => (
              <option key={item} value={item}>{DEAL_SOURCE[item]?.label ?? item}</option>
            ))}
          </select>

          <select
            value={employeeFilter}
            onChange={(e) => {
              setEmployeeFilter(e.target.value)
              // Состав колонок поменялся — показываем снова первую страницу.
              setShownPerStage({})
            }}
            className="h-10 rounded-xl border border-gray-200 bg-white/80 px-3 text-base text-gray-600 outline-none transition-colors focus:border-gray-300 md:h-9 md:text-[13px]"
            title="Фильтр по ответственному"
          >
            <option value="all">Все сотрудники</option>
            <option value="none">Без ответственного</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          </div>
          <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1 md:flex-none">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setShownPerStage({})
              }}
              placeholder="Клиент, телефон, название…"
              className="h-10 w-full rounded-xl border border-gray-200 bg-white/80 pl-8 pr-3 text-base outline-none transition-colors focus:border-gray-300 md:h-9 md:w-56 md:text-[13px]"
            />
          </div>

          <button
            onClick={() => openNew(defaultStageId)}
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-4 text-[13px] font-semibold text-white brand-gradient brand-shadow transition-transform hover:-translate-y-0.5 md:h-9"
          >
            <Plus size={16} />
            <span className="md:hidden">Создать</span>
            <span className="hidden md:inline">Создать сделку</span>
          </button>
          </div>
        </div>
      </div>

      {/* Доска */}
      {/* На телефоне колонка почти во весь экран, следующая выглядывает;
          листается по одной (snap). */}
      <div className="flex min-h-0 flex-1 snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-4 scroll-hidden md:snap-none md:gap-4 md:px-6 md:pb-6">
        {stages.map((stage) => {
          const list = columns.get(stage.id) ?? []
          const totals = columnTotals(list)
          const shown = shownPerStage[stage.id] ?? COLUMN_PAGE
          const visible = list.length > shown ? list.slice(0, shown) : list
          const isTarget = dragOverStage === stage.id
          return (
            <div
              key={stage.id}
              onDragOver={(e) => {
                if (!dragId) return
                e.preventDefault()
                setDragOverStage(stage.id)
              }}
              onDrop={(e) => {
                e.preventDefault()
                void performDrop(stage.id)
              }}
              className={cn(
                'flex w-[290px] max-w-[calc(100vw-56px)] shrink-0 snap-start flex-col rounded-2xl border transition-colors md:max-w-none',
                isTarget && dragId
                  ? 'border-[#cdb8e8] bg-[#f1ebfa]/60'
                  : 'border-gray-100 bg-gray-50/60'
              )}
            >
              {/* Заголовок колонки */}
              <div className="px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: stage.color }}
                    />
                    <span className="truncate text-[13px] font-semibold text-gray-700">
                      {stage.name}
                    </span>
                    <span
                      className="shrink-0 rounded-full px-1.5 text-[11px] font-semibold"
                      style={{ color: stage.color, background: stageSoft(stage.color) }}
                    >
                      {list.length}
                    </span>
                  </div>
                  <button
                    onClick={() => openNew(stage.id)}
                    className="-m-1.5 rounded-lg p-2.5 text-gray-400 transition-colors hover:bg-white hover:text-gray-600 md:m-0 md:p-1"
                    title="Добавить в этап"
                    aria-label="Добавить в этап"
                  >
                    <Plus size={15} />
                  </button>
                </div>
                <p className="mt-1 truncate text-[11px] text-gray-400">
                  {totals.length ? totals.join(' · ') : 'Без суммы'}
                </p>
              </div>

              {/* Карточки */}
              <div className="flex-1 space-y-2 overflow-y-auto px-2.5 pb-3 scroll-hidden">
                {visible.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    employees={employeeMap}
                    stageColor={stage.color}
                    dragging={dragId === deal.id}
                    // Под оформлением (этап «Передан менеджеру») или уже
                    // оформлен (status won) — оба требуют внимания менеджера,
                    // подсвечиваются одинаково ярко, но с разной подписью.
                    urgentLabel={
                      deal.status === 'won'
                        ? 'Оформлено'
                        : deal.stage_id === orderStageId
                          ? 'Оформляет'
                          : null
                    }
                    onDragStart={() => beginDrag(deal.id)}
                    onDragEnd={endDrag}
                    onClick={() => openEdit(deal)}
                  />
                ))}

                {list.length > visible.length && (
                  <button
                    onClick={() =>
                      setShownPerStage((prev) => ({
                        ...prev,
                        [stage.id]: (prev[stage.id] ?? COLUMN_PAGE) + COLUMN_PAGE,
                      }))
                    }
                    className="w-full rounded-xl border border-dashed border-gray-200 py-2.5 text-center text-[12px] font-medium text-gray-500 transition-colors hover:border-gray-300 hover:text-gray-700"
                  >
                    Показать ещё {Math.min(COLUMN_PAGE, list.length - visible.length)} из {list.length - visible.length}
                  </button>
                )}

                {dragId && isTarget && <div className="h-[3px] rounded-full bg-[#5115a4]" />}

                {list.length === 0 && !dragId && (
                  <button
                    onClick={() => openNew(stage.id)}
                    className="w-full rounded-xl border border-dashed border-gray-200 py-6 text-center text-[12px] text-gray-400 transition-colors hover:border-gray-300 hover:text-gray-500"
                  >
                    Пусто — добавить сделку
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {modal.open && (
        <DealModal
          deal={modal.deal}
          isNew={modal.isNew}
          defaultStageId={modal.stageId || defaultStageId}
          stages={stages}
          employees={employees}
          me={me}
          onClose={closeModal}
          onSaved={refresh}
        />
      )}
    </div>
  )
}
