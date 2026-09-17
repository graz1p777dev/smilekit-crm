'use client'

// Настройки → «Смены»: сотрудники смен (имя, телефон WhatsApp, пароль),
// WhatsApp владельца для подтверждений, кто сейчас на смене, запросы и
// последние смены.

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Copy, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  createStaffMember, getStaffAdminData, ownerCloseShift, ownerDecideRequest, saveOwnerWhatsapp,
  setStaffActive, updateStaffMember, type AdminResult, type StaffAdminData,
} from '@/actions/staff-admin'
import { recoverFromStaleAction } from '@/lib/stale-action'

const VIOLET = '#5115a4'

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Bishkek', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso))

const REASON: Record<string, string> = { closed: 'закрыл сам', replaced: 'передал смену', owner: 'закрыл владелец' }

type Form = { id: string | null; fullName: string; phone: string; password: string }
const EMPTY_FORM: Form = { id: null, fullName: '', phone: '', password: '' }

export default function StaffSettings() {
  const [data, setData] = useState<StaffAdminData | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [form, setForm] = useState<Form | null>(null)
  const [ownerPhone, setOwnerPhone] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const next = await getStaffAdminData()
      if (!next) { setLoadError(true); return }
      setData(next)
      setOwnerPhone(next.ownerWhatsapp ?? '')
    } catch (error) {
      if (!recoverFromStaleAction(error)) setLoadError(true)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(timer)
  }, [load])

  async function run(task: () => Promise<AdminResult>, success: string): Promise<boolean> {
    setBusy(true)
    try {
      const result = await task()
      if (!result.success) { toast.error(result.error); return false }
      toast.success(success)
      await load()
      return true
    } catch (error) {
      if (!recoverFromStaleAction(error)) toast.error('Не удалось сохранить')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function submitForm(event: React.FormEvent) {
    event.preventDefault()
    if (!form) return
    const input = { fullName: form.fullName, phone: form.phone, password: form.password }
    const ok = form.id
      ? await run(() => updateStaffMember(form.id as string, input), 'Сотрудник сохранён')
      : await run(() => createStaffMember(input), 'Сотрудник добавлен')
    if (ok) setForm(null)
  }

  if (loadError) return <p className="p-8 text-sm text-gray-500">Раздел доступен только владельцу.</p>
  if (!data) return <p className="p-8 text-sm text-gray-500">Загрузка…</p>

  const onShift = data.staff.filter((s) => s.onShiftSince)

  return (
    <div className="flex flex-col gap-5 p-4 md:p-8">
      <section className="rounded-2xl border bg-white p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Users size={16} /> Как это работает</h2>
        <p className="mt-2 text-sm text-gray-600">
          Сотрудник открывает ссылку или пишет боту <b>/staffs</b> в Telegram, вводит свой пароль и нажимает
          «Моя смена», «Работа вместе» или «Закрыть смену». Всё, что происходит в смену, засчитывается ему
          в аналитике. Если на смене уже кто-то есть, нужно подтверждение: оно уходит в WhatsApp тому, кто
          на смене, и вам. 5 неверных паролей — вход закрыт на 5 минут.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="rounded-lg bg-gray-50 px-3 py-2 text-sm">{data.portalUrl}</code>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { void navigator.clipboard.writeText(data.portalUrl).then(() => toast.success('Ссылка скопирована')) }}
          >
            <Copy size={14} /> Копировать
          </Button>
        </div>
      </section>

      <section className="rounded-2xl border bg-white p-5">
        <Label htmlFor="owner-whatsapp" className="text-sm font-semibold">Ваш WhatsApp для подтверждений</Label>
        <p className="mt-1 text-xs text-gray-500">Сюда приходит ссылка «Подтвердить / Отклонить», когда кто-то просит забрать смену.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Input
            id="owner-whatsapp"
            value={ownerPhone}
            onChange={(e) => setOwnerPhone(e.target.value)}
            placeholder="+996 700 123 456"
            className="max-w-xs"
          />
          <Button
            disabled={busy}
            onClick={() => run(() => saveOwnerWhatsapp(ownerPhone), 'Номер сохранён')}
            className="text-white"
            style={{ background: VIOLET }}
          >
            Сохранить
          </Button>
        </div>
        {!data.ownerWhatsapp && <p className="mt-2 text-xs" style={{ color: '#b91c1c' }}>Номер не указан — подтверждения вам не приходят.</p>}
      </section>

      {data.pending.length > 0 && (
        <section className="rounded-2xl border-2 p-5" style={{ borderColor: '#f5a623', background: '#fffbeb' }}>
          <h2 className="text-sm font-semibold">Ждут подтверждения</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {data.pending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="flex-1">
                  <b>{r.requesterName}</b> — {r.kind === 'take' ? 'просит забрать смену' : 'просит работать вместе'} ({dateTime(r.createdAt)})
                </span>
                <Button size="sm" disabled={busy} className="text-white" style={{ background: '#059669' }}
                  onClick={() => run(() => ownerDecideRequest(r.id, 'approve'), 'Подтверждено')}>Подтвердить</Button>
                <Button size="sm" variant="outline" disabled={busy}
                  onClick={() => run(() => ownerDecideRequest(r.id, 'reject'), 'Отклонено')}>Отклонить</Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border bg-white p-5">
        <h2 className="text-sm font-semibold">Сейчас на смене</h2>
        {onShift.length === 0
          ? <p className="mt-2 text-sm text-gray-500">Никого</p>
          : (
            <ul className="mt-2 flex flex-col gap-2">
              {onShift.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="flex-1">
                    🟢 <b>{s.fullName}</b> с {dateTime(s.onShiftSince as string)}{s.mode === 'joint' ? ' (вместе)' : ''}
                  </span>
                  <Button size="sm" variant="outline" disabled={busy}
                    onClick={() => run(() => ownerCloseShift(s.id), 'Смена закрыта')}>Закрыть смену</Button>
                </li>
              ))}
            </ul>
          )}
      </section>

      <section className="rounded-2xl border bg-white p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Сотрудники смен</h2>
          {!form && (
            <Button size="sm" className="text-white" style={{ background: VIOLET }} onClick={() => setForm(EMPTY_FORM)}>
              Добавить сотрудника
            </Button>
          )}
        </div>

        {form && (
          <form onSubmit={submitForm} className="mt-4 grid gap-3 rounded-xl bg-gray-50 p-4 md:grid-cols-3">
            <div>
              <Label htmlFor="staff-name">Имя и фамилия</Label>
              <Input id="staff-name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="staff-phone">WhatsApp</Label>
              <Input id="staff-phone" value={form.phone} placeholder="0700 123 456" onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="staff-password">{form.id ? 'Новый пароль (пусто — не менять)' : 'Пароль'}</Label>
              <Input id="staff-password" value={form.password} autoComplete="off" onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </div>
            <div className="flex gap-2 md:col-span-3">
              <Button type="submit" disabled={busy} className="text-white" style={{ background: VIOLET }}>
                {form.id ? 'Сохранить' : 'Добавить'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setForm(null)}>Отмена</Button>
            </div>
            <p className="text-xs text-gray-500 md:col-span-3">
              Пароль у каждого свой — два сотрудника с одинаковым паролем невозможны. Пароль хранится зашифрованным:
              если сотрудник забыл, задайте новый.
            </p>
          </form>
        )}

        {data.staff.length === 0 && !form
          ? <p className="mt-3 text-sm text-gray-500">Сотрудников пока нет.</p>
          : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500">
                    <th className="py-2 pr-3">Сотрудник</th>
                    <th className="py-2 pr-3">WhatsApp</th>
                    <th className="py-2 pr-3">Telegram</th>
                    <th className="py-2 pr-3">Статус</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {data.staff.map((s) => (
                    <tr key={s.id} className="border-t" style={s.isActive ? undefined : { opacity: 0.55 }}>
                      <td className="py-2 pr-3 font-medium">{s.fullName}</td>
                      <td className="py-2 pr-3">+{s.phone}</td>
                      <td className="py-2 pr-3">{s.telegramLinked ? 'вошёл в /staffs' : '—'}</td>
                      <td className="py-2 pr-3">{!s.isActive ? 'отключён' : s.onShiftSince ? 'на смене' : 'не на смене'}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <Button size="sm" variant="ghost" disabled={busy}
                          onClick={() => setForm({ id: s.id, fullName: s.fullName, phone: s.phone, password: '' })}>
                          Изменить
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy}
                          onClick={() => run(() => setStaffActive(s.id, !s.isActive), s.isActive ? 'Сотрудник отключён' : 'Сотрудник включён')}>
                          {s.isActive ? 'Отключить' : 'Включить'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      <section className="rounded-2xl border bg-white p-5">
        <h2 className="text-sm font-semibold">Последние смены</h2>
        {data.recentShifts.length === 0
          ? <p className="mt-2 text-sm text-gray-500">Смен ещё не было.</p>
          : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {data.recentShifts.map((s) => (
                    <tr key={s.id} className="border-t">
                      <td className="py-2 pr-3 font-medium">{s.staffName}</td>
                      <td className="py-2 pr-3">{dateTime(s.startedAt)} — {s.endedAt ? dateTime(s.endedAt) : 'сейчас'}</td>
                      <td className="py-2 pr-3">{s.mode === 'joint' ? 'вместе' : 'одна смена'}</td>
                      <td className="py-2 text-gray-500">{s.endedReason ? REASON[s.endedReason] ?? '' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </div>
  )
}
