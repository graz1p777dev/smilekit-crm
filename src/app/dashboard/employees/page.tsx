'use client'

import { useEffect, useState, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import type { Employee, Department } from '@/types'
import { ROLE_LABELS } from '@/lib/constants'
import { getEmployees, getEmployeeLeadReplies } from '@/actions/employees'
import { archiveEmployee, restoreEmployee } from '@/actions/employees'
import { startImpersonation } from '@/actions/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Plus, Search, RotateCcw, UserX,
  ChevronUp, ChevronDown, ChevronsUpDown,
  Users, UserCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import EmployeeModal from '@/components/EmployeeModal'
import EmptyState from '@/components/common/EmptyState'

// ─── Константы ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20

const ROLE_BADGE_COLORS: Record<string, { bg: string; color: string }> = {
  owner:     { bg: '#faf8f7', color: '#5115a4' },
  rop:       { bg: '#dcfce7', color: '#15803d' },
  mp:        { bg: '#f1ebfa', color: '#5115a4' },
  lmai:      { bg: '#fef9c3', color: '#854d0e' },
  accountant:{ bg: '#fce7f3', color: '#5115a4' },
}

const STATUS_BADGE: Record<string, { bg: string; color: string; label: string }> = {
  active:    { bg: '#dcfce7', color: '#15803d', label: 'Активный' },
  probation: { bg: '#fef9c3', color: '#854d0e', label: 'Испыт. срок' },
  archived:  { bg: '#fdfbfb', color: '#6b7280', label: 'Уволен' },
}

// ─── Вспомогательные компоненты ──────────────────────────────────────────────

type SortKey = 'name' | 'role' | 'status' | 'hireDate' | 'leads'
type SortDir = 'asc' | 'desc'

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ChevronsUpDown size={12} style={{ color: '#7d7174' }} />
  return dir === 'asc'
    ? <ChevronUp size={12} style={{ color: '#5115a4' }} />
    : <ChevronDown size={12} style={{ color: '#5115a4' }} />
}

function ThCell({
  label, col, sortKey, sortDir, onSort,
}: {
  label: string; col: SortKey; sortKey: SortKey; sortDir: SortDir; onSort: (c: SortKey) => void
}) {
  return (
    <th
      onClick={() => onSort(col)}
      className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider cursor-pointer select-none whitespace-nowrap"
      style={{ color: '#7d7174' }}
    >
      <div className="flex items-center gap-1">
        {label}
        <SortIcon active={sortKey === col} dir={sortDir} />
      </div>
    </th>
  )
}

function StatCard({ icon, label, value, sub, accent }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; accent?: string
}) {
  return (
    <div className="rounded-2xl p-4 flex items-start gap-3" style={{ backgroundColor: '#ffffff' }}>
      <div
        className="flex items-center justify-center w-10 h-10 rounded-xl flex-shrink-0"
        style={{ backgroundColor: accent ?? '#5115a4' }}
      >
        {icon}
      </div>
      <div>
        <div className="text-xs font-medium mb-1" style={{ color: '#7d7174' }}>{label}</div>
        <div className="text-xl font-bold leading-tight" style={{ color: '#1b1517' }}>{value}</div>
        {sub && <div className="text-xs mt-0.5" style={{ color: '#7d7174' }}>{sub}</div>}
      </div>
    </div>
  )
}

// ─── Компонент страницы ───────────────────────────────────────────────────────

export default function EmployeesPage() {
  const router = useRouter()
  const { user: currentEmployee } = useAuth()
  const isOwner = currentEmployee?.role === 'owner'

  // ── Фильтры ───────────────────────────────────────────────────────────────
  const [search,       setSearch]       = useState('')
  const [filterRole,   setFilterRole]   = useState('')
  const [filterStatus, setFilterStatus] = useState('active')
  const [showArchived, setShowArchived] = useState(false)
  const [page,         setPage]         = useState(0)

  // ── Данные сотрудников ────────────────────────────────────────────────────
  const [employees, setEmployees]     = useState<Employee[]>([])
  const [departments, setDepartments] = useState<Pick<Department, 'id' | 'name'>[]>([])
  const [roles, setRoles]             = useState<{ value: string; label: string }[]>([])
  const [schedules, setSchedules]     = useState<{ value: string; label: string }[]>([])
  const [loadingCrud, setLoadingCrud] = useState(true)
  const [reloadKey, setReloadKey]     = useState(0)
  // Сколько разных клиентов сотрудник обслужил своими руками из CRM.
  // Едет отдельным запросом: перебор переписки заметно тяжелее списка
  // сотрудников, и таблица не должна его ждать.
  const [leadReplies, setLeadReplies] = useState<Record<string, number>>({})

  useEffect(() => {
    let cancelled = false
    setLoadingCrud(true)
    getEmployees(showArchived).then(({ employees: emps, departments: depts, roles: roleList, schedules: schedList }) => {
      if (cancelled) return
      setEmployees(emps)
      setDepartments(depts)
      setRoles(roleList)
      setSchedules(schedList)
      setLoadingCrud(false)
    })
    // Счётчик лидов не блокирует таблицу: приезжает следом и дозаполняет
    // колонку. Пока не приехал — в ячейках 0.
    getEmployeeLeadReplies()
      .then((counts) => { if (!cancelled) setLeadReplies(counts) })
      .catch(() => { /* колонка просто останется нулевой */ })
    return () => { cancelled = true }
  }, [showArchived, reloadKey])

  // ── Агрегированные статы ──────────────────────────────────────────────────
  const stats = useMemo(() => {
    const nonOwner = employees.filter(e => e.role !== 'owner')
    const active   = nonOwner.filter(e => !e.deleted_at)
    const archived = nonOwner.filter(e =>  e.deleted_at)
    return { total: nonOwner.length, active: active.length, archived: archived.length }
  }, [employees])

  // ── Сортировка ────────────────────────────────────────────────────────────
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  // ── Фильтрация + сортировка ───────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    let rows = employees.filter(e => {
      if (e.role === 'owner') return false
      const isArchived = Boolean(e.deleted_at) || e.status === 'archived'
      if (!showArchived && isArchived) return false
      if (q && !(
        e.name.toLowerCase().includes(q) ||
        e.email.toLowerCase().includes(q) ||
        (e.phone ?? '').includes(q)
      )) return false
      if (filterRole && e.role !== filterRole) return false
      if (!showArchived && filterStatus && e.status !== filterStatus) return false
      return true
    })

    const dir = sortDir === 'asc' ? 1 : -1
    rows = [...rows].sort((a, b) => {
      switch (sortKey) {
        case 'name':     return dir * a.name.localeCompare(b.name, 'ru')
        case 'role':     return dir * a.role.localeCompare(b.role)
        case 'status':   return dir * a.status.localeCompare(b.status)
        case 'hireDate': return dir * ((a.hire_date ?? '').localeCompare(b.hire_date ?? ''))
        case 'leads':    return dir * ((leadReplies[a.id] ?? 0) - (leadReplies[b.id] ?? 0))
        default: return 0
      }
    })

    return rows
  }, [employees, search, filterRole, filterStatus, showArchived, sortKey, sortDir, leadReplies])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paged      = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // ── CRUD handlers ─────────────────────────────────────────────────────────
  const [selected,  setSelected]  = useState<Employee | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [isNew,     setIsNew]     = useState(false)
  const [isPending, startTransition] = useTransition()

  const handleNew  = () => { setSelected(null); setIsNew(true); setModalOpen(true) }
  const handleEdit = (emp: Employee) => { if (!isOwner) return; setSelected(emp); setIsNew(false); setModalOpen(true) }
  const handleModalSave = () => { setModalOpen(false); setReloadKey(k => k + 1) }

  const handleImpersonate = (emp: Employee) => {
    startTransition(async () => {
      const r = await startImpersonation(emp.id)
      if (r.success) {
        // Полная перезагрузка страницы обязательна: AuthProvider инициализирует
        // impersonating через useState(initialImpersonation) из root layout SSR.
        // router.push/refresh не переинициализирует useState в уже смонтированном
        // Client Component — cookie устанавливается, но баннер не появляется.
        window.location.href = '/dashboard'
      } else {
        toast.error(r.error)
      }
    })
  }

  const handleArchive = (emp: Employee) => {
    if (emp.deleted_at || emp.status === 'archived') {
      toast.error('Этот сотрудник уже уволен')
      return
    }
    if (!window.confirm(`Уволить «${emp.name}»?`)) return
    startTransition(async () => {
      const r = await archiveEmployee(emp.id)
      if (r.success) {
        toast.success('Сотрудник уволен')
        setEmployees(prev => prev.map(e =>
          e.id === emp.id ? { ...e, deleted_at: new Date().toISOString(), status: 'archived' as const } : e
        ))
      } else toast.error(r.error)
    })
  }

  const handleRestore = (emp: Employee) => {
    startTransition(async () => {
      const r = await restoreEmployee(emp.id)
      if (r.success) {
        toast.success('Сотрудник восстановлен')
        setEmployees(prev => prev.map(e =>
          e.id === emp.id ? { ...e, deleted_at: null, status: 'active' as const } : e
        ))
      } else toast.error(r.error)
    })
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const thProps = { sortKey, sortDir, onSort: handleSort }

  return (
    <div className="min-h-screen" style={{ backgroundColor: '#fdfbfb' }}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-6 py-4"
        style={{ backgroundColor: '#ffffff', borderBottom: '1px solid #ece5e5' }}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9" style={{ borderRadius: 14, backgroundColor: 'rgba(81, 21, 164,0.10)' }}>
            <Users size={18} color="#5115a4" />
          </div>
          <div>
            <div className="font-semibold text-base leading-tight" style={{ color: '#1b1517' }}>Сотрудники</div>
            <div className="text-xs" style={{ color: '#7d7174' }}>Управление командой</div>
          </div>
        </div>

        {isOwner && (
          <Button
            onClick={handleNew}
            className="text-white rounded-xl font-medium"
            style={{ backgroundColor: '#5115a4' }}
          >
            <Plus style={{ width: 16, height: 16, marginRight: 6 }} />
            Добавить
          </Button>
        )}
      </div>

      <div className="p-5 space-y-4">
        {/* Stat Cards — только количественные метрики, без финансов */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
          <StatCard icon={<Users size={18} color="#ffffff" />}     label="Всего сотрудников" value={String(stats.total)} sub={`${stats.archived} в архиве`} />
          <StatCard icon={<UserCheck size={18} color="#ffffff" />} label="Активных"           value={String(stats.active)} />
        </div>

        {/* Таблица */}
        <div className="rounded-2xl overflow-hidden" style={{ backgroundColor: '#ffffff' }}>
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-3 p-4" style={{ borderBottom: '1px solid #ebebee' }}>
            <div className="relative flex-1" style={{ minWidth: 220 }}>
              <Search style={{
                position: 'absolute', left: 12, top: '50%',
                transform: 'translateY(-50%)', width: 15, height: 15, color: '#7d7174',
              }} />
              <Input
                className="pl-9 bg-white border-gray-200 h-9 rounded-xl"
                placeholder="Имя, email, телефон..."
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(0) }}
              />
            </div>

            <Select value={filterRole} onValueChange={v => { setFilterRole(v ?? ''); setPage(0) }}>
              <SelectTrigger className="h-9 rounded-xl border-gray-200 bg-white" style={{ minWidth: 140 }}>
                <SelectValue>
                  {filterRole ? (ROLE_LABELS[filterRole as keyof typeof ROLE_LABELS] ?? filterRole) : 'Все роли'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Все роли</SelectItem>
                <SelectItem value="rop">РОП</SelectItem>
                <SelectItem value="mp">МП</SelectItem>
                <SelectItem value="lmai">LMAI</SelectItem>
                <SelectItem value="accountant">Бухгалтер</SelectItem>
              </SelectContent>
            </Select>

            {!showArchived && (
              <Select value={filterStatus} onValueChange={v => { setFilterStatus(v ?? ''); setPage(0) }}>
                <SelectTrigger className="h-9 rounded-xl border-gray-200 bg-white" style={{ minWidth: 150 }}>
                  <SelectValue>
                    {filterStatus === 'active' ? 'Активные' : filterStatus === 'probation' ? 'Испытат. срок' : 'Все статусы'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Все статусы</SelectItem>
                  <SelectItem value="active">Активные</SelectItem>
                  <SelectItem value="probation">Испытательный срок</SelectItem>
                </SelectContent>
              </Select>
            )}

            {isOwner && (
              <Button
                variant={showArchived ? 'default' : 'outline'}
                className="h-9 rounded-xl gap-2"
                style={showArchived ? { backgroundColor: '#5115a4', color: '#fff' } : {}}
                onClick={() => {
                  const next = !showArchived
                  setShowArchived(next)
                  if (next) setFilterStatus('')
                  setPage(0)
                }}
              >
                <UserX style={{ width: 14, height: 14 }} />
                {showArchived ? 'Скрыть уволенных' : 'Уволенные'}
              </Button>
            )}

            <div className="text-xs ml-auto" style={{ color: '#7d7174' }}>
              {filtered.length} сотрудников
            </div>
          </div>

          {/* Таблица */}
          <div style={{ overflowX: 'auto' }}>
            <table className="w-full" style={{ fontSize: 13 }}>
              <thead style={{ backgroundColor: '#fdfbfb', borderBottom: '1px solid #ebebee' }}>
                <tr>
                  <ThCell label="Сотрудник"   col="name"     {...thProps} />
                  <ThCell label="Роль"        col="role"     {...thProps} />
                  <ThCell label="Статус"      col="status"   {...thProps} />
                  <ThCell label="Лидов ответил" col="leads"    {...thProps} />
                  <ThCell label="Дата приёма"  col="hireDate" {...thProps} />
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {loadingCrud ? (
                  [...Array(5)].map((_, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #fdfbfb' }}>
                      {[...Array(6)].map((__, j) => (
                        <td key={j} className="px-4 py-3">
                          <div className="animate-pulse rounded" style={{ height: 14, backgroundColor: '#fdfbfb' }} />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : paged.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8">
                      <EmptyState
                        icon={Users}
                        title={search || filterRole ? 'Под фильтры никто не подходит' : 'Сотрудников пока нет'}
                        hint={search || filterRole ? 'Измените поиск или сбросьте фильтры.' : 'Нажмите «Добавить», чтобы завести первого сотрудника.'}
                      />
                    </td>
                  </tr>
                ) : (
                  paged.map(emp => {
                    const roleColor  = ROLE_BADGE_COLORS[emp.role] ?? { bg: '#fdfbfb', color: '#3a3032' }
                    const statusInfo = STATUS_BADGE[emp.status] ?? STATUS_BADGE.active
                    const isArchived = Boolean(emp.deleted_at) || emp.status === 'archived'

                    return (
                      <tr
                        key={emp.id}
                        style={{ borderBottom: '1px solid #fdfbfb', opacity: isArchived ? 0.55 : 1, cursor: 'pointer' }}
                        onClick={() => router.push(`/dashboard/employees/${emp.id}`)}
                        onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#fdfbfb')}
                        onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                      >
                        {/* Сотрудник */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <div
                              className="w-8 h-8 rounded-full flex items-center justify-center font-bold shrink-0"
                              style={{ backgroundColor: isArchived ? '#ece5e5' : '#faf8f7', color: isArchived ? '#a19698' : '#5115a4', fontSize: 11 }}
                            >
                              {emp.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
                            </div>
                            <div>
                              <div className="font-medium" style={{ color: '#1b1517' }}>{emp.name}</div>
                              <div style={{ fontSize: 11, color: '#7d7174' }}>{emp.email}</div>
                            </div>
                          </div>
                        </td>

                        {/* Роль */}
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded-full text-[11px] font-medium" style={{ backgroundColor: roleColor.bg, color: roleColor.color }}>
                            {ROLE_LABELS[emp.role as keyof typeof ROLE_LABELS] ?? emp.role}
                          </span>
                        </td>

                        {/* Статус */}
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded-full text-[11px] font-medium" style={{ backgroundColor: statusInfo.bg, color: statusInfo.color }}>
                            {statusInfo.label}
                          </span>
                        </td>

                        {/* Лидов ответил — разных клиентов, которым писал сам */}
                        <td className="px-4 py-3">
                          <span
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums"
                            style={
                              (leadReplies[emp.id] ?? 0) > 0
                                ? { backgroundColor: '#f1ebfa', color: '#5115a4' }
                                : { backgroundColor: '#fdfbfb', color: '#7d7174' }
                            }
                            title="Скольким разным клиентам сотрудник ответил из CRM"
                          >
                            {leadReplies[emp.id] ?? 0}
                          </span>
                        </td>

                        {/* Дата приёма */}
                        <td className="px-4 py-3" style={{ color: '#6b7280' }}>
                          {emp.hire_date
                            ? new Date(emp.hire_date).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' })
                            : '—'}
                        </td>

                        {/* Действия */}
                        <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                          {isOwner && (
                            isArchived ? (
                              <Button
                                variant="ghost" size="sm"
                                className="h-7 rounded-lg gap-1 text-xs"
                                style={{ color: '#15803d' }}
                                disabled={isPending}
                                onClick={() => handleRestore(emp)}
                              >
                                <RotateCcw style={{ width: 13, height: 13 }} /> Восстановить
                              </Button>
                            ) : (
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  variant="ghost" size="sm"
                                  className="h-7 rounded-lg gap-1 text-xs"
                                  style={{ color: '#6b7280' }}
                                  disabled={isPending}
                                  onClick={e => { e.stopPropagation(); handleImpersonate(emp) }}
                                  title="Войти от имени сотрудника"
                                >
                                  👤 От имени
                                </Button>
                                <Button
                                  variant="ghost" size="sm"
                                  className="h-7 rounded-lg gap-1 text-xs"
                                  style={{ color: '#5115a4' }}
                                  onClick={e => { e.stopPropagation(); handleEdit(emp) }}
                                >
                                  Изменить
                                </Button>
                                <Button
                                  variant="ghost" size="sm"
                                  className="h-7 rounded-lg gap-1 text-xs"
                                  style={{ color: '#5115a4' }}
                                  disabled={isPending}
                                  onClick={() => handleArchive(emp)}
                                >
                                  <UserX style={{ width: 13, height: 13 }} /> Уволить
                                </Button>
                              </div>
                            )
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Пагинация */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3" style={{ borderTop: '1px solid #ebebee' }}>
              <span style={{ fontSize: 13, color: '#7d7174' }}>
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} из {filtered.length}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="rounded-lg">←</Button>
                <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="rounded-lg">→</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Employee Modal (create/edit) */}
      {modalOpen && (
        <EmployeeModal
          employee={selected}
          isNew={isNew}
          departments={departments}
          roles={roles.length > 0 ? roles : undefined}
          schedules={schedules.length > 0 ? schedules : undefined}
          onClose={() => setModalOpen(false)}
          onSave={handleModalSave}
        />
      )}
    </div>
  )
}
