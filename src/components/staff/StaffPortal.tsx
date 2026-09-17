'use client'

// Страница смены для сотрудника: пароль → «Вход: Имя Фамилия» → ОК → кнопки
// «Моя смена», «Работа вместе», «Закрыть смену». Открывается с телефона,
// поэтому всё крупно и в одну колонку.

import { useCallback, useEffect, useState } from 'react'
import {
  decideByToken, staffPortalAction, staffPortalDecide, staffPortalLogin, staffPortalLogout,
  staffPortalState, type PortalResult,
} from '@/actions/staff-portal'
import type { StaffState } from '@/lib/staff/service'

const VIOLET = '#5115a4'

const time = (iso: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Bishkek', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

type Stage = 'loading' | 'password' | 'welcome' | 'menu'

export default function StaffPortal() {
  const [stage, setStage] = useState<Stage>('loading')
  const [state, setState] = useState<StaffState | null>(null)
  const [password, setPassword] = useState('')
  const [welcomeName, setWelcomeName] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await staffPortalState()
      setState(next)
      return next
    } catch {
      setNotice({ ok: false, text: 'Нет связи с сервером. Обновите страницу.' })
      return null
    }
  }, [])

  useEffect(() => {
    let alive = true
    staffPortalState()
      .then((next) => {
        if (!alive) return
        setState(next)
        setStage(next.staff ? 'menu' : 'password')
      })
      .catch(() => { if (alive) setStage('password') })
    return () => { alive = false }
  }, [])

  // Пока страница открыта, подтягиваем изменения: запрос на подтверждение
  // или передачу смены сотрудник должен увидеть без перезагрузки.
  useEffect(() => {
    if (stage !== 'menu') return
    const timer = setInterval(() => { void refresh() }, 10_000)
    return () => clearInterval(timer)
  }, [stage, refresh])

  async function login(event: React.FormEvent) {
    event.preventDefault()
    if (!password.trim() || busy) return
    setBusy(true)
    setNotice(null)
    const result = await staffPortalLogin(password).catch(() => ({ ok: false as const, error: 'Нет связи с сервером' }))
    setBusy(false)
    setPassword('')
    if (!result.ok) {
      setNotice({ ok: false, text: result.error })
      return
    }
    setWelcomeName(result.fullName)
    setStage('welcome')
  }

  async function run(task: () => Promise<PortalResult>) {
    if (busy) return
    setBusy(true)
    setNotice(null)
    const result = await task().catch(() => ({ ok: false as const, error: 'Нет связи с сервером' }))
    setBusy(false)
    setNotice(result.ok ? { ok: true, text: result.message ?? 'Готово' } : { ok: false, text: result.error })
    const next = await refresh()
    if (next && !next.staff) setStage('password')
  }

  async function logout() {
    await staffPortalLogout()
    setState(null)
    setNotice(null)
    setStage('password')
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-4 px-4 py-8">
      <header className="text-center">
        <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: VIOLET }}>SmileKit</p>
        <h1 className="mt-1 text-2xl font-semibold" style={{ fontFamily: 'var(--font-display)' }}>Смена</h1>
      </header>

      {notice && (
        <p
          role="status"
          className="rounded-xl px-4 py-3 text-sm"
          style={notice.ok ? { background: '#ecfdf5', color: '#065f46' } : { background: '#fef2f2', color: '#991b1b' }}
        >
          {notice.text}
        </p>
      )}

      {stage === 'loading' && <p className="text-center text-sm text-gray-500">Загрузка…</p>}

      {stage === 'password' && (
        <form onSubmit={login} className="flex flex-col gap-3 rounded-2xl border bg-white p-5">
          <label htmlFor="staff-password" className="text-sm font-medium">Ваш пароль</label>
          <input
            id="staff-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-xl border px-4 py-3 text-lg outline-none focus:border-violet-500"
          />
          <button
            type="submit"
            disabled={busy || !password.trim()}
            className="rounded-xl py-3 text-base font-semibold text-white disabled:opacity-50"
            style={{ background: VIOLET }}
          >
            {busy ? 'Проверяем…' : 'Войти'}
          </button>
        </form>
      )}

      {stage === 'welcome' && (
        <div className="flex flex-col gap-4 rounded-2xl border bg-white p-5 text-center">
          <p className="text-sm text-gray-500">Вход</p>
          <p className="text-xl font-semibold">{welcomeName}</p>
          <button
            onClick={() => { void refresh().then(() => setStage('menu')) }}
            className="rounded-xl py-3 text-base font-semibold text-white"
            style={{ background: VIOLET }}
          >
            ОК
          </button>
          <button onClick={logout} className="text-sm text-gray-500 underline">Это не я</button>
        </div>
      )}

      {stage === 'menu' && state?.staff && (
        <>
          <section className="rounded-2xl border bg-white p-5">
            <p className="text-sm text-gray-500">Вы вошли как</p>
            <p className="text-lg font-semibold">{state.staff.fullName}</p>
            <p className="mt-3 text-sm">
              {state.myShift
                ? <>🟢 Вы на смене с {time(state.myShift.startedAt)}{state.myShift.mode === 'joint' ? ' (вместе)' : ''}</>
                : 'Вы не на смене'}
            </p>
            <p className="mt-1 text-sm text-gray-600">
              {state.onShift.length
                ? `Сейчас на смене: ${state.onShift.map((s) => `${s.fullName} с ${time(s.startedAt)}`).join(', ')}`
                : 'Сейчас на смене никого нет'}
            </p>
          </section>

          {state.awaitingMyDecision.map((request) => (
            <section key={request.requestId} className="rounded-2xl border-2 p-5" style={{ borderColor: '#f59e0b', background: '#fffbeb' }}>
              <p className="font-semibold">
                {request.requesterName} просит {request.kind === 'take' ? 'забрать вашу смену' : 'работать вместе с вами'}
              </p>
              <p className="mt-1 text-xs text-gray-600">Запрос в {time(request.createdAt)}</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  disabled={busy}
                  onClick={() => run(() => staffPortalDecide(request.requestId, 'approve'))}
                  className="rounded-xl py-3 font-semibold text-white disabled:opacity-50"
                  style={{ background: '#059669' }}
                >
                  Подтвердить
                </button>
                <button
                  disabled={busy}
                  onClick={() => run(() => staffPortalDecide(request.requestId, 'reject'))}
                  className="rounded-xl border py-3 font-semibold disabled:opacity-50"
                >
                  Отклонить
                </button>
              </div>
            </section>
          ))}

          {state.myPendingRequest ? (
            <section className="rounded-2xl border bg-white p-5">
              <p className="text-sm">
                ⏳ Запрос «{state.myPendingRequest.kind === 'take' ? 'Моя смена' : 'Работа вместе'}» отправлен в{' '}
                {time(state.myPendingRequest.createdAt)}. Ждём подтверждения.
              </p>
              <button
                disabled={busy}
                onClick={() => run(() => staffPortalAction('cancel_request'))}
                className="mt-3 w-full rounded-xl border py-3 font-semibold disabled:opacity-50"
              >
                Отменить запрос
              </button>
            </section>
          ) : (
            <div className="flex flex-col gap-2">
              {!state.myShift && (
                <>
                  <button
                    disabled={busy}
                    onClick={() => run(() => staffPortalAction('take'))}
                    className="rounded-2xl py-4 text-lg font-semibold text-white disabled:opacity-50"
                    style={{ background: '#059669' }}
                  >
                    🟢 Моя смена
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => run(() => staffPortalAction('join'))}
                    className="rounded-2xl py-4 text-lg font-semibold text-white disabled:opacity-50"
                    style={{ background: VIOLET }}
                  >
                    🤝 Работа вместе
                  </button>
                </>
              )}
              {state.myShift && (
                <button
                  disabled={busy}
                  onClick={() => run(() => staffPortalAction('close'))}
                  className="rounded-2xl py-4 text-lg font-semibold text-white disabled:opacity-50"
                  style={{ background: '#17102a' }}
                >
                  🔴 Закрыть смену
                </button>
              )}
            </div>
          )}

          <p className="text-center text-xs text-gray-500">
            Если на смене уже кто-то есть, «Моя смена» и «Работа вместе» начнутся только после его подтверждения.
          </p>
          <button onClick={logout} className="text-sm text-gray-500 underline">Выйти</button>
        </>
      )}
    </main>
  )
}

export function ConfirmRequest({ token }: { token: string }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<PortalResult | null>(null)

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true)
    const next = await decideByToken(token, decision).catch(() => ({ ok: false as const, error: 'Нет связи с сервером' }))
    setBusy(false)
    setResult(next)
  }

  if (result) {
    return (
      <p
        role="status"
        className="rounded-xl px-4 py-3 text-center"
        style={result.ok ? { background: '#ecfdf5', color: '#065f46' } : { background: '#fef2f2', color: '#991b1b' }}
      >
        {result.ok ? result.message : result.error}
      </p>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        disabled={busy}
        onClick={() => decide('approve')}
        className="rounded-xl py-4 text-lg font-semibold text-white disabled:opacity-50"
        style={{ background: '#059669' }}
      >
        Подтвердить
      </button>
      <button
        disabled={busy}
        onClick={() => decide('reject')}
        className="rounded-xl border bg-white py-4 text-lg font-semibold disabled:opacity-50"
      >
        Отклонить
      </button>
    </div>
  )
}
