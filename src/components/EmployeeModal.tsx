'use client'

import { useTransition, useState, useRef } from 'react'
import { toast } from 'sonner'
import { X, Eye, EyeOff } from 'lucide-react'
import { PASSWORD_MIN_LENGTH, validatePassword, passwordStrength } from '@/lib/auth-validation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Employee, Department } from '@/types'
import {
  createEmployee,
  updateEmployee,
  type EmployeeFormData,
} from '@/actions/employees'

// ─── Константы ────────────────────────────────────────────────────────────────

const ROLES = [
  { value: 'owner',     label: 'Владелец' },
  { value: 'rop',       label: 'РОП' },
  { value: 'mp',        label: 'МП' },
  { value: 'lmai',      label: 'LMAI' },
  { value: 'accountant',label: 'Бухгалтер' },
] as const

const STATUSES = [
  { value: 'active',     label: 'Активный' },
  { value: 'probation',  label: 'Испытательный срок' },
  { value: 'archived',   label: 'Уволен' },
] as const

// Фолбэк на случай, если БД ещё не вернула графики
const FALLBACK_SCHEDULES = [
  { value: '5/2', label: '5/2 (Пн–Пт)' },
  { value: '2/2', label: '2/2' },
]

// ─── FormState ────────────────────────────────────────────────────────────────

interface FormState {
  name:             string
  email:            string
  phone:            string
  role:             string
  department_id:    string
  hire_date:        string
  birth_date:       string
  schedule_type:    string
  work_start_time:  string
  work_end_time:    string
  status:           string
  notes:            string
  initial_password: string
  confirm_password: string
}

// Маска +996 (XXX) XX-XX-XX. digits — только пользовательские цифры (без кода страны).
function applyPhoneMask(digits: string): string {
  const d = digits.slice(0, 9)  // 3 (оператор) + 2+2+2 = 9 цифр
  if (d.length === 0) return ''
  let result = '+996 (' + d.slice(0, 3)
  if (d.length <= 3) return result
  result += ') ' + d.slice(3, 5)
  if (d.length <= 5) return result
  result += '-' + d.slice(5, 7)
  if (d.length <= 7) return result
  result += '-' + d.slice(7, 9)
  return result
}

// Извлекает пользовательские цифры из сырого значения поля (убирает код страны 996)
function extractUserDigits(raw: string): string {
  return raw.replace(/\D/g, '').replace(/^996/, '').slice(0, 9)
}

interface Props {
  employee:    Employee | null
  isNew:       boolean
  departments: Pick<Department, 'id' | 'name'>[]
  roles?:      { value: string; label: string }[]
  schedules?:  { value: string; label: string }[]
  onClose:     () => void
  onSave:      () => void
}

// ─── Компонент ────────────────────────────────────────────────────────────────

export default function EmployeeModal({ employee, isNew, departments, roles, schedules, onClose, onSave }: Props) {
  const [isPending, startTransition] = useTransition()
  const [showPassword, setShowPassword] = useState(false)
  const hireDateRef  = useRef<HTMLInputElement>(null)
  const birthDateRef = useRef<HTMLInputElement>(null)

  const [form, setForm] = useState<FormState>({
    name:             employee?.name ?? '',
    email:            employee?.email ?? '',
    phone:            employee?.phone ? applyPhoneMask(extractUserDigits(employee.phone)) : '',
    role:             employee?.role ?? 'mp',
    department_id:    employee?.department_id ?? '',
    hire_date:        employee?.hire_date ?? '',
    birth_date:       employee?.birth_date ?? '',
    schedule_type:    employee?.schedule_type ?? '5/2',
    work_start_time:  employee?.work_start_time?.slice(0, 5) ?? '09:00',
    work_end_time:    employee?.work_end_time?.slice(0, 5) ?? '18:00',
    status:           employee?.status ?? 'active',
    notes:            employee?.notes ?? '',
    initial_password: '',
    confirm_password: '',
  })

  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({})

  const set = (field: keyof FormState, value: string) =>
    setForm(f => ({ ...f, [field]: value }))

  // Из маскированного телефона извлекаем только цифры для хранения в БД
  const rawPhone = (masked: string) => {
    const digits = masked.replace(/\D/g, '')
    return digits.length > 3 ? '+' + digits : null
  }

  // setErrors применится только к следующему рендеру, а сообщение нужно
  // прямо сейчас — держим последний результат проверки ещё и в ref.
  const errorsRef = useRef<Partial<Record<keyof FormState, string>>>({})
  const passwordRef = useRef<HTMLDivElement | null>(null)

  const buildPayload = (): EmployeeFormData => ({
    name:             form.name,
    email:            form.email,
    phone:            rawPhone(form.phone),
    role:             form.role as EmployeeFormData['role'],
    department_id:    form.department_id || null,
    hire_date:        form.hire_date || null,
    birth_date:       form.birth_date || null,
    base_salary:      0,
    schedule_type:    form.schedule_type as EmployeeFormData['schedule_type'],
    work_start_time:  form.work_start_time,
    work_end_time:    form.work_end_time,
    status:           form.status as EmployeeFormData['status'],
    notes:            form.notes || null,
    initial_password: isNew ? form.initial_password : undefined,
  })

  const validate = (): boolean => {
    const e: Partial<Record<keyof FormState, string>> = {}
    if (!form.name.trim() || form.name.trim().length < 2) e.name = 'Введите имя (мин. 2 символа)'
    if (!form.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = 'Некорректный email'
    if (isNew) {
      const pwErr = validatePassword(form.initial_password)
      if (pwErr) e.initial_password = pwErr
      else if (form.initial_password !== form.confirm_password) e.confirm_password = 'Пароли не совпадают'
    }
    setErrors(e)
    errorsRef.current = e
    return Object.keys(e).length === 0
  }

  const handleSave = () => {
    if (!validate()) {
      // Раньше здесь был молчаливый return. Обязательный пароль живёт в самом
      // низу длинной формы, поэтому при пустом пароле кнопка «Сохранить»
      // выглядела просто нерабочей: ошибка рисовалась за пределами экрана.
      // Теперь говорим вслух и подкручиваем к проблемному месту.
      const first = Object.values(errorsRef.current)[0]
      if (first) toast.error(first)
      if (errorsRef.current.initial_password || errorsRef.current.confirm_password) {
        passwordRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      return
    }
    startTransition(async () => {
      const payload = buildPayload()
      const result = isNew
        ? await createEmployee(payload)
        : await updateEmployee(employee!.id, payload)

      if (result.success) {
        toast.success(isNew ? 'Сотрудник добавлен' : 'Изменения сохранены')
        onSave()
      } else {
        toast.error(result.error)
      }
    })
  }

  const inputClass = 'h-9 rounded-lg border-gray-200 text-sm focus-visible:ring-1'
  const errorClass = 'text-[11px] text-red-500 mt-0.5'

  const initials = form.name.trim()
    ? form.name.trim().split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : '??'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(28,23,25,0.45)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="relative w-full max-w-xl mx-4 rounded-2xl overflow-hidden flex flex-col"
        style={{ backgroundColor: '#ffffff', maxHeight: '90vh' }}
      >
        {/* Шапка */}
        <div
          className="flex items-center gap-3 px-6 py-4 shrink-0"
          style={{ background: 'linear-gradient(135deg, #8a68ad 0%, #5115a4 100%)' }}
        >
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0"
            style={{ backgroundColor: 'rgba(255,255,255,0.2)', color: '#fff' }}
          >
            {initials}
          </div>
          <div>
            <h2 className="font-bold text-white text-base">
              {isNew ? 'Новый сотрудник' : 'Редактировать сотрудника'}
            </h2>
            <p className="text-[12px]" style={{ color: 'rgba(255,255,255,0.6)' }}>
              {isNew ? 'Введите данные' : form.name}
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg p-1.5 transition-colors"
            style={{ color: 'rgba(255,255,255,0.7)' }}
          >
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>

        {/* Тело */}
        <div className="overflow-y-auto p-6 space-y-5">

          {/* ─── Основные данные ─── */}
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Основные данные</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="col-span-2 space-y-1">
              <Label className="text-xs font-semibold text-gray-500">ФИО *</Label>
              <Input
                value={form.name}
                onChange={e => {
                  // только буквы (включая кириллицу/латиницу), пробелы и дефис
                  const v = e.target.value.replace(/[^A-Za-zА-ЯЁа-яёҢңҮүӨөҺһ\s-]/g, '')
                  set('name', v)
                }}
                placeholder="Иванов Иван Иванович"
                className={inputClass}
              />
              {errors.name && <p className={errorClass}>{errors.name}</p>}
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Email *</Label>
              <Input
                type="email"
                value={form.email}
                onChange={e => set('email', e.target.value)}
                placeholder="email@example.com"
                className={inputClass}
              />
              {errors.email && <p className={errorClass}>{errors.email}</p>}
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Телефон</Label>
              <Input
                value={form.phone}
                onChange={e => {
                  const digits = extractUserDigits(e.target.value)
                  set('phone', applyPhoneMask(digits))
                }}
                onKeyDown={e => {
                  if (e.key === 'Backspace') {
                    e.preventDefault()
                    const digits = extractUserDigits(form.phone)
                    const next = digits.slice(0, -1)
                    set('phone', applyPhoneMask(next))
                  }
                }}
                placeholder="+996 (XXX) XX-XX-XX"
                className={inputClass}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Роль *</Label>
              <Select value={form.role} onValueChange={v => set('role', v ?? 'mp')}>
                <SelectTrigger className={inputClass}>
                  <SelectValue>{(roles ?? ROLES).find(r => r.value === form.role)?.label ?? '—'}</SelectValue>
                </SelectTrigger>
                <SelectContent className="z-[99999]">
                  {(roles ?? ROLES).map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Статус</Label>
              <Select value={form.status} onValueChange={v => set('status', v ?? 'active')}>
                <SelectTrigger className={inputClass}>
                  <SelectValue>{STATUSES.find(s => s.value === form.status)?.label ?? '—'}</SelectValue>
                </SelectTrigger>
                <SelectContent className="z-[99999]">
                  {STATUSES.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="col-span-2 space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Отдел</Label>
              <Select value={form.department_id} onValueChange={v => set('department_id', v ?? '')}>
                <SelectTrigger className={inputClass}>
                  <SelectValue>
                    {form.department_id
                      ? departments.find(d => d.id === form.department_id)?.name ?? '—'
                      : '—'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="z-[99999]">
                  <SelectItem value="">—</SelectItem>
                  {departments.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {/* ─── Пароль (только для нового сотрудника) ─── */}
          {isNew && (
            <div
              ref={passwordRef}
              className="rounded-xl p-4 space-y-3"
              style={{ backgroundColor: '#fdfbfb', border: '1px solid #ebebee' }}
            >
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                Доступ в систему
              </p>

              <div className="space-y-1">
                <Label className="text-xs font-semibold text-gray-500">Начальный пароль *</Label>
                <div className="relative">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={form.initial_password}
                    onChange={e => set('initial_password', e.target.value)}
                    placeholder={`Мин. ${PASSWORD_MIN_LENGTH} символов, заглавная, цифра`}
                    className={inputClass}
                    style={{ paddingRight: 36 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    tabIndex={-1}
                  >
                    {showPassword
                      ? <EyeOff style={{ width: 15, height: 15 }} />
                      : <Eye style={{ width: 15, height: 15 }} />
                    }
                  </button>
                </div>
                {errors.initial_password && <p className={errorClass}>{errors.initial_password}</p>}

                {/* Индикатор силы пароля */}
                {form.initial_password.length > 0 && (() => {
                  const strength = passwordStrength(form.initial_password)
                  const map = {
                    weak:   { label: 'Слабый',   color: '#5115a4', width: '33%' },
                    medium: { label: 'Средний',   color: '#b45309', width: '66%' },
                    strong: { label: 'Сильный',   color: '#15803d', width: '100%' },
                  }
                  const s = map[strength]
                  return (
                    <div className="space-y-1">
                      <div className="h-1 rounded-full bg-gray-200 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-300"
                          style={{ width: s.width, backgroundColor: s.color }}
                        />
                      </div>
                      <p className="text-[11px]" style={{ color: s.color }}>{s.label}</p>
                    </div>
                  )
                })()}
              </div>

              <div className="space-y-1">
                <Label className="text-xs font-semibold text-gray-500">Подтвердить пароль *</Label>
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={form.confirm_password}
                  onChange={e => set('confirm_password', e.target.value)}
                  placeholder="Повторите пароль"
                  className={inputClass}
                />
                {errors.confirm_password && <p className={errorClass}>{errors.confirm_password}</p>}
              </div>
            </div>
          )}


          {/* ─── Даты ─── */}
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Даты</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Дата приёма</Label>
              <Input
                ref={hireDateRef}
                type="date"
                value={form.hire_date}
                onChange={e => set('hire_date', e.target.value)}
                onClick={() => { try { hireDateRef.current?.showPicker() } catch {} }}
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Дата рождения</Label>
              <Input
                ref={birthDateRef}
                type="date"
                value={form.birth_date}
                onChange={e => set('birth_date', e.target.value)}
                onClick={() => { try { birthDateRef.current?.showPicker() } catch {} }}
                className={inputClass}
              />
            </div>
          </div>

          {/* ─── Расписание ─── */}
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Расписание</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1 min-w-0">
              <Label className="text-xs font-semibold text-gray-500">График</Label>
              <Select value={form.schedule_type} onValueChange={v => set('schedule_type', v ?? '5/2')}>
                <SelectTrigger className={`${inputClass} w-full min-w-0`}>
                  <SelectValue className="truncate">{(schedules ?? FALLBACK_SCHEDULES).find(s => s.value === form.schedule_type)?.label ?? form.schedule_type ?? '—'}</SelectValue>
                </SelectTrigger>
                <SelectContent className="z-[99999]">
                  {(schedules ?? FALLBACK_SCHEDULES).map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Начало работы</Label>
              <Input
                type="time"
                value={form.work_start_time}
                onChange={e => set('work_start_time', e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-gray-500">Конец работы</Label>
              <Input
                type="time"
                value={form.work_end_time}
                onChange={e => set('work_end_time', e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          {/* ─── Заметки ─── */}
          <div className="space-y-1">
            <Label className="text-xs font-semibold text-gray-500">Заметки</Label>
            <textarea
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              rows={2}
              placeholder="Дополнительная информация..."
              className="w-full text-sm rounded-lg px-3 py-2 resize-none focus:outline-none border border-gray-200"
              style={{ fontSize: 13 }}
            />
          </div>


        </div>

        {/* Футер */}
        <div
          className="shrink-0 flex items-center justify-end gap-2 px-6 py-4"
          style={{ borderTop: '1px solid #fdfbfb' }}
        >
          <Button variant="ghost" onClick={onClose} className="rounded-xl" disabled={isPending}>
            Отмена
          </Button>
          <Button
            onClick={handleSave}
            disabled={isPending}
            className="rounded-xl text-white font-medium"
            style={{ backgroundColor: '#5115a4' }}
          >
            {isPending ? 'Сохранение...' : 'Сохранить'}
          </Button>
        </div>
      </div>
    </div>
  )
}
