'use client'

// Автоматические рассылки: правило, которое само создаёт обычную рассылку
// каждые N дней в заданное время. Сами отправки уходят в общую историю —
// там они помечены как автоматические.

import { useEffect, useRef, useState, useTransition } from 'react'
import { Plus, Power, RefreshCw, Repeat, Trash2, UsersRound } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import {
  deleteRecurringCampaign,
  getAudiencePreview,
  refreshRecurringEstimate,
  saveRecurringCampaign,
  setRecurringActive,
  type CampaignAudience,
  type RecurringCampaignRow,
} from '@/actions/campaigns'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { VOICE_MESSAGES, voiceById, voiceSrc } from '@/config/voice-messages'
import {
  recurringAudienceFilter, recurringPeriodLabel, type RecurringAudienceOptions, type RecurringPeriodMode,
} from '@/lib/campaigns/recurring-filter'

const AUDIENCE_LABELS: Record<CampaignAudience, string> = {
  not_purchased: 'кто не купил',
  purchased: 'кто купил',
  all: 'всем',
}

/** Период повторения — то, что реально нужно на практике. */
const INTERVALS = [
  { days: 1, label: 'каждый день' },
  { days: 2, label: 'через день' },
  { days: 3, label: 'раз в 3 дня' },
  { days: 7, label: 'раз в неделю' },
]

/**
 * Период по последнему сообщению клиента — те же варианты, что у обычной
 * рассылки, плюс «с даты». Считается заново в момент каждой отправки.
 */
type PeriodChoice = { key: string; label: string; mode: RecurringPeriodMode; days: number | null }
const PERIODS: PeriodChoice[] = [
  { key: 'd1', label: 'за сегодня', mode: 'days', days: 1 },
  { key: 'd2', label: 'за 2 дня', mode: 'days', days: 2 },
  { key: 'd3', label: 'за 3 дня', mode: 'days', days: 3 },
  { key: 'd5', label: 'за 5 дней', mode: 'days', days: 5 },
  { key: 'd7', label: 'за неделю', mode: 'days', days: 7 },
  { key: 'd30', label: 'за месяц', mode: 'days', days: 30 },
  { key: 'h24', label: 'за сутки (24 ч)', mode: 'hours24', days: null },
  { key: 'since', label: 'с прошлой рассылки', mode: 'since_last', days: null },
  { key: 'date', label: 'с даты…', mode: 'from_date', days: null },
  { key: 'all', label: 'без ограничения', mode: 'days', days: null },
]

const time = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Bishkek', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

/**
 * Маленькая панель «сколько получат» — считает тем же правилом, что и
 * отправка, на текущий момент. С задержкой, чтобы не считать на каждый клик.
 */
function AudienceBadge({ options, lastCampaignAt }: { options: RecurringAudienceOptions; lastCampaignAt: string | null }) {
  const [state, setState] = useState<{ key: string; count: number | null; manager: number; reached: number; loading: boolean }>({
    key: '', count: null, manager: 0, reached: 0, loading: false,
  })
  const seq = useRef(0)
  const key = JSON.stringify(options) + (lastCampaignAt ?? '')

  useEffect(() => {
    const id = ++seq.current
    const timer = setTimeout(() => {
      const filter = recurringAudienceFilter(options, Date.now(), lastCampaignAt)
      if (!filter) {
        setState({ key, count: 0, manager: 0, reached: 0, loading: false })
        return
      }
      setState((prev) => ({ ...prev, loading: true }))
      getAudiencePreview({
        dateFrom: filter.from, dateTo: filter.to, audience: filter.audience,
        includeManagerChats: filter.includeManagerChats, skipReachedSince: filter.skipReachedSince,
      })
        .then((preview) => {
          if (id !== seq.current) return
          setState({ key, count: preview.count, manager: preview.excluded.managerChats, reached: preview.excluded.alreadyReached, loading: false })
        })
        .catch(() => { if (id === seq.current) setState((prev) => ({ ...prev, loading: false })) })
    }, 400)
    return () => clearTimeout(timer)
    // options сериализованы в key — зависимость по нему, а не по объекту.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-3 py-2.5 text-sm" style={{ background: '#f1ebfa' }}>
      <UsersRound className="size-4" style={{ color: '#5115a4' }} />
      <span style={{ color: 'var(--ink)' }}>
        Если отправить сейчас, получат:{' '}
        <strong style={{ color: '#5115a4' }}>{state.loading || state.count === null ? '…' : state.count}</strong>
      </span>
      {!state.loading && (state.manager > 0 || state.reached > 0) && (
        <span className="text-xs" style={{ color: 'var(--ink-3)' }}>
          пропущено: {state.manager > 0 && `${state.manager} в переписке с менеджером`}
          {state.manager > 0 && state.reached > 0 && ', '}
          {state.reached > 0 && `${state.reached} уже получили сегодня`}
        </span>
      )}
      {options.period_mode === 'since_last' && !lastCampaignAt && (
        <span className="text-xs" style={{ color: '#b45309' }}>прошлых рассылок нет — считать не от чего</span>
      )}
    </div>
  )
}

export default function RecurringCampaigns({ rules, lastCampaignAt }: { rules: RecurringCampaignRow[]; lastCampaignAt: string | null }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)

  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [audience, setAudience] = useState<CampaignAudience>('not_purchased')
  const [intervalDays, setIntervalDays] = useState(1)
  const [sendAtTime, setSendAtTime] = useState('12:00')
  const [periodKey, setPeriodKey] = useState('d1')
  const [fromDate, setFromDate] = useState('')
  const [includeManagerChats, setIncludeManagerChats] = useState(false)
  const [skipReachedToday, setSkipReachedToday] = useState(true)
  const [refreshing, setRefreshing] = useState<string | null>(null)

  const period = PERIODS.find((p) => p.key === periodKey) ?? PERIODS[0]
  const options: RecurringAudienceOptions = {
    audience,
    period_mode: period.mode,
    window_days: period.mode === 'days' ? period.days : null,
    from_date: period.mode === 'from_date' ? fromDate || null : null,
    include_manager_chats: includeManagerChats,
    skip_reached_today: skipReachedToday,
  }

  function save() {
    if (!title.trim()) return toast.error('Введите название')
    if (!message.trim() && !voiceId) return toast.error('Напишите текст или выберите голосовое')
    if (period.mode === 'from_date' && !fromDate) return toast.error('Выберите дату, с которой брать клиентов')

    startTransition(async () => {
      const result = await saveRecurringCampaign({
        title, message, voiceId: voiceId || undefined,
        audience, intervalDays, sendAtTime,
        windowDays: options.window_days,
        periodMode: options.period_mode,
        fromDate: options.from_date,
        includeManagerChats,
        skipReachedToday,
      })
      if (!result.success) return void toast.error(result.error)
      toast.success('Автоматическая рассылка создана')
      setTitle(''); setMessage(''); setVoiceId(''); setOpen(false)
      router.refresh()
    })
  }

  function refreshEstimate(id: string) {
    setRefreshing(id)
    startTransition(async () => {
      const result = await refreshRecurringEstimate(id)
      setRefreshing(null)
      if (!result.success) return void toast.error(result.error)
      toast.success(`Аудитория пересчитана: ${result.count}`)
      router.refresh()
    })
  }

  function toggle(rule: RecurringCampaignRow) {
    startTransition(async () => {
      const result = await setRecurringActive(rule.id, !rule.is_active)
      if (!result.success) return void toast.error(result.error)
      toast.success(rule.is_active ? 'Рассылка остановлена' : 'Рассылка включена')
      router.refresh()
    })
  }

  function remove(id: string) {
    startTransition(async () => {
      const result = await deleteRecurringCampaign(id)
      if (!result.success) return void toast.error(result.error)
      toast.success('Удалена')
      router.refresh()
    })
  }

  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Repeat className="size-4" style={{ color: 'var(--ink-3)' }} />
          <h2 className="text-base font-bold" style={{ color: 'var(--ink)' }}>Автоматические рассылки</h2>
        </div>
        <Button variant={open ? 'outline' : 'default'} size="sm" onClick={() => setOpen((v) => !v)}>
          <Plus /> {open ? 'Свернуть' : 'Создать'}
        </Button>
      </div>
      <p className="mb-3 text-sm" style={{ color: 'var(--ink-3)' }}>
        Уходит сама в выбранное время с выбранным периодом. Каждая отправка попадает
        в историю ниже с пометкой «автоматическая».
      </p>

      {open && (
        <div className="mb-4 min-w-0 space-y-4 rounded-2xl bg-white p-4 ring-1 ring-black/5 md:p-5">
          <div className="space-y-2">
            <Label>Название</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: Утреннее напоминание" maxLength={160} />
          </div>

          <div className="space-y-2">
            <Label>Сообщение клиенту</Label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={voiceId ? 'Необязательно: текст рядом с голосовым…' : 'Текст рассылки…'}
              maxLength={4000}
              className="min-h-28 resize-y"
            />
          </div>

          {VOICE_MESSAGES.length > 0 && (
            <div className="space-y-2">
              <Label>Голосовое (необязательно)</Label>
              {VOICE_MESSAGES.map((voice) => (
                <label key={voice.id} className="flex cursor-pointer items-center gap-2 rounded-xl p-2" style={{ background: 'var(--surface-2)' }}>
                  <input
                    type="radio"
                    name="recurring-voice"
                    className="size-4"
                    checked={voiceId === voice.id}
                    onChange={() => setVoiceId(voice.id)}
                  />
                  <span className="text-sm" style={{ color: 'var(--ink)' }}>{voice.label}</span>
                  <audio controls preload="none" src={voiceSrc(voice)} className="ml-auto" style={{ height: 30 }} />
                </label>
              ))}
              {voiceId && (
                <button type="button" onClick={() => setVoiceId('')} className="py-2 text-xs font-semibold md:py-0" style={{ color: 'var(--ink-3)' }}>
                  Отправлять без голосового
                </button>
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="recurring-time">Во сколько отправлять</Label>
              <Input id="recurring-time" type="time" value={sendAtTime} onChange={(e) => setSendAtTime(e.target.value)} />
              <p className="text-xs" style={{ color: 'var(--ink-3)' }}>Время по Бишкеку</p>
            </div>
            <div className="space-y-2">
              <Label>Как часто</Label>
              <div className="flex flex-wrap gap-2">
                {INTERVALS.map((item) => (
                  <Button
                    key={item.days}
                    type="button"
                    size="sm"
                    variant={intervalDays === item.days ? 'default' : 'outline'}
                    onClick={() => setIntervalDays(item.days)}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Кому отправлять</Label>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(AUDIENCE_LABELS) as CampaignAudience[]).map((key) => (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant={audience === key ? 'default' : 'outline'}
                  onClick={() => setAudience(key)}
                >
                  {AUDIENCE_LABELS[key]}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Какие клиенты по последнему сообщению</Label>
            <div className="flex flex-wrap gap-2">
              {PERIODS.map((item) => (
                <Button
                  key={item.key}
                  type="button"
                  size="sm"
                  variant={periodKey === item.key ? 'default' : 'outline'}
                  onClick={() => setPeriodKey(item.key)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
            {period.mode === 'from_date' && (
              <div className="flex flex-wrap items-center gap-2">
                <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="max-w-[200px]" aria-label="С какой даты" />
                <span className="text-xs" style={{ color: 'var(--ink-3)' }}>клиенты, писавшие с этой даты по момент отправки</span>
              </div>
            )}
            <p className="text-xs" style={{ color: 'var(--ink-3)' }}>
              Период считается заново при каждой отправке: «за сегодня» — сутки дня отправки по Бишкеку,
              «за сутки» — ровно 24 часа до отправки, «с прошлой рассылки» — от создания предыдущей рассылки.
            </p>
          </div>

          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-2 text-sm" style={{ color: 'var(--ink)' }}>
              <input type="checkbox" className="mt-0.5 size-4" checked={skipReachedToday} onChange={(e) => setSkipReachedToday(e.target.checked)} />
              <span>Не слать тем, кто уже получил рассылку сегодня</span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm" style={{ color: 'var(--ink)' }}>
              <input type="checkbox" className="mt-0.5 size-4" checked={includeManagerChats} onChange={(e) => setIncludeManagerChats(e.target.checked)} />
              <span>Слать и тем, с кем менеджер переписывается прямо сейчас (писал за последние 30 минут)</span>
            </label>
          </div>

          <AudienceBadge options={options} lastCampaignAt={lastCampaignAt} />

          <Button className="w-full" disabled={pending} onClick={save}>
            {pending ? 'Сохраняем…' : 'Создать автоматическую рассылку'}
          </Button>
        </div>
      )}

      <div className="space-y-3">
        {rules.length === 0 && (
          <div className="rounded-2xl bg-white px-5 py-8 text-center text-sm ring-1 ring-black/5" style={{ color: 'var(--ink-3)' }}>
            Автоматических рассылок пока нет
          </div>
        )}
        {rules.map((rule) => {
          const voice = voiceById(rule.voice_id)
          const interval = INTERVALS.find((item) => item.days === rule.interval_days)
          return (
            <article key={rule.id} className="min-w-0 rounded-2xl bg-white p-4 ring-1 ring-black/5 md:p-5">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold" style={{ color: 'var(--ink)' }}>{rule.title}</h3>
                <span
                  className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  style={rule.is_active
                    ? { color: '#087a55', background: '#ddf8ed' }
                    : { color: '#6b6570', background: '#f1eef3' }}
                >
                  {rule.is_active ? 'Активная' : 'Неактивная'}
                </span>
                <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ color: '#6d28d9', background: '#f0e8ff' }}>
                  Автоматическая
                </span>
              </div>

              {rule.message && (
                <p className="mt-1 text-sm" style={{ color: 'var(--ink-3)' }}>{rule.message}</p>
              )}
              {voice && (
                <p className="mt-1 text-xs font-semibold" style={{ color: '#5115a4' }}>🎤 {voice.label}</p>
              )}

              <p className="mt-2 text-xs" style={{ color: 'var(--ink-3)' }}>
                {interval?.label ?? `раз в ${rule.interval_days} дн.`} в {rule.send_at_time.slice(0, 5)} ·{' '}
                {AUDIENCE_LABELS[rule.audience]} · {recurringPeriodLabel(rule)}
                {rule.skip_reached_today ? ' · без повтора за день' : ''}
                {rule.include_manager_chats ? ' · и в чаты с менеджером' : ''}
                {rule.last_run_at && ` · последний запуск ${new Date(rule.last_run_at).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`}
              </p>
              <p className="mt-1 text-xs" style={{ color: 'var(--ink-3)' }}>
                Создал: <strong style={{ color: 'var(--ink-2)' }}>{rule.author ?? 'неизвестно'}</strong>
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-sm" style={{ background: '#f1ebfa' }}>
                <UsersRound className="size-4" style={{ color: '#5115a4' }} />
                <span style={{ color: 'var(--ink)' }}>
                  Аудитория:{' '}
                  <strong style={{ color: '#5115a4' }}>{rule.audience_estimate ?? '—'}</strong>
                </span>
                <span className="text-xs" style={{ color: 'var(--ink-3)' }}>
                  {rule.audience_estimated_at
                    ? `посчитано ${time(rule.audience_estimated_at)}, пересчёт раз в сутки`
                    : 'ещё не считалась'}
                </span>
                <Button variant="ghost" size="sm" className="ml-auto h-7" disabled={pending} onClick={() => refreshEstimate(rule.id)}>
                  <RefreshCw className={refreshing === rule.id ? 'animate-spin' : undefined} /> Обновить
                </Button>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={pending} onClick={() => toggle(rule)}>
                  <Power /> {rule.is_active ? 'Остановить' : 'Включить'}
                </Button>
                <Button variant="ghost" size="sm" disabled={pending} onClick={() => remove(rule.id)} className="text-red-600">
                  <Trash2 /> Удалить
                </Button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
