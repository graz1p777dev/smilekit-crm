'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Bot, CalendarClock, CheckCircle2, Clock3, Mic, Send, ShieldCheck, ShieldX, Trash2, UsersRound, X, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import {
  addOptOutPhone,
  cancelCampaign,
  getEligibleCountForRange,
  getLastCampaignMoment,
  removeOptOutPhone,
  scheduleCampaign,
  type CampaignAudience,
  type CampaignsData,
  type CampaignRow,
} from '@/actions/campaigns'
import PageHeader from '@/components/PageHeader'
import CampaignProgress from './CampaignProgress'
import RecurringCampaigns from './RecurringCampaigns'
import { VOICE_MESSAGES, voiceById, voiceSrc } from '@/config/voice-messages'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

const statusMeta: Record<CampaignRow['status'], { label: string; color: string; bg: string }> = {
  scheduled: { label: 'Запланирована', color: '#6d28d9', bg: '#f0e8ff' },
  running: { label: 'Отправляется', color: '#9a6700', bg: '#fff5cc' },
  completed: { label: 'Завершена', color: '#087a55', bg: '#ddf8ed' },
  cancelled: { label: 'Отменена', color: '#6b6570', bg: '#f1eef3' },
  failed: { label: 'Ошибка', color: '#b42318', bg: '#fee4e2' },
}

// Периоды считаем по Бишкеку (UTC+6 круглый год), а не по часовому поясу
// браузера: рассылка и клиенты живут в Кыргызстане.
const BISHKEK_OFFSET_MS = 6 * 3600_000

function bishkekNow() {
  return new Date(Date.now() + BISHKEK_OFFSET_MS)
}

/** Дата в формате поля <input type="date">. */
function asDateInput(date: Date) {
  return date.toISOString().slice(0, 10)
}

/** Понедельник текущей недели по Бишкеку. */
function weekStart() {
  const now = bishkekNow()
  const weekday = now.getUTCDay() // 0 — воскресенье
  const backToMonday = weekday === 0 ? 6 : weekday - 1
  return new Date(now.getTime() - backToMonday * 86400_000)
}

/** Начало периода из N последних суток, включая сегодняшние. */
function daysBack(days: number) {
  return new Date(bishkekNow().getTime() - (days - 1) * 86400_000)
}

type PresetKey = 'today' | 'd2' | 'd3' | 'd5' | 'week' | 'h24' | 'since_last'

/** Момент N часов назад. Вынесено из компонента: Date.now() внутри тела
 *  компонента линтер React считает нечистым вызовом при рендере. */
function hoursAgoIso(hours: number) {
  return new Date(Date.now() - hours * 3600_000).toISOString()
}

/** Граница в поле периода — это дата (YYYY-MM-DD) или точный момент (ISO). */
const isExactMoment = (value: string) => value !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(value)

function formatMoment(iso: string) {
  return new Intl.DateTimeFormat('ru-KG', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bishkek',
  }).format(new Date(iso))
}

/**
 * Быстрый выбор периода. Верхняя граница у всех — сегодня; отличается только
 * нижняя. Добавить новый период — дописать сюда строку.
 */
const DATE_PRESETS: { key: PresetKey; label: string; from: () => Date }[] = [
  { key: 'today', label: 'За сегодня',    from: () => daysBack(1) },
  { key: 'd2',    label: 'За 2 дня',      from: () => daysBack(2) },
  { key: 'd3',    label: 'За 3 дня',      from: () => daysBack(3) },
  { key: 'd5',    label: 'За 5 дней',     from: () => daysBack(5) },
  { key: 'week',  label: 'За эту неделю', from: weekStart },
]

/**
 * Кнопки с ТОЧНЫМ временем, а не целыми сутками. Нижняя граница — момент,
 * верхней нет: получатели фиксируются при создании рассылки, поэтому «до
 * сейчас» и есть «до времени этой рассылки».
 */
const EXACT_PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'h24',        label: 'За сутки' },
  { key: 'since_last', label: 'С прошлой рассылки' },
]

function defaultSchedule() {
  const date = new Date(Date.now() + 60 * 60 * 1000)
  date.setMinutes(Math.ceil(date.getMinutes() / 5) * 5, 0, 0)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ru-KG', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bishkek',
  }).format(new Date(value))
}

export default function CampaignsClient({ initialData }: { initialData: CampaignsData }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [scheduledAt, setScheduledAt] = useState(defaultSchedule)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  // Какую кнопку нажали. Раньше «активность» выводилась из самих дат, и в
  // понедельник подсвечивались обе: начало недели совпадает с сегодняшним
  // днём, диапазоны получаются одинаковые. Храним выбор явно.
  const [preset, setPreset] = useState<PresetKey | null>(null)
  // Для «С прошлой рассылки» — от какой именно рассылки считаем, чтобы
  // подписать это под кнопками.
  const [sinceCampaign, setSinceCampaign] = useState<string | null>(null)
  const [presetLoading, setPresetLoading] = useState(false)

  function clearPeriod() {
    setDateFrom('')
    setDateTo('')
    setPreset(null)
    setSinceCampaign(null)
  }

  async function applyExactPreset(key: PresetKey) {
    if (key === 'h24') {
      setDateFrom(hoursAgoIso(24))
      setDateTo('')
      setSinceCampaign(null)
      setPreset('h24')
      return
    }
    // since_last: момент берём с сервера — там же решается, какая рассылка
    // считается «прошлой» (отменённые не в счёт).
    setPresetLoading(true)
    try {
      const last = await getLastCampaignMoment()
      if (!last) {
        toast.error('Прошлых рассылок нет — считать не от чего')
        return
      }
      setDateFrom(last.at)
      setDateTo('')
      setSinceCampaign(last.title)
      setPreset('since_last')
    } finally {
      setPresetLoading(false)
    }
  }
  const [audience, setAudience] = useState<CampaignAudience>('not_purchased')
  const [eligibleCount, setEligibleCount] = useState<number | null>(initialData.eligibleCount)
  const requestSeq = useRef(0)
  const [countLoading, setCountLoading] = useState(false)
  const [optOutPhone, setOptOutPhone] = useState('')
  const [optOutReason, setOptOutReason] = useState('')
  const [optOutBlockBot, setOptOutBlockBot] = useState(false)

  useEffect(() => {
    // Пока рассылка отправляется, счётчик должен двигаться на глазах —
    // 15 секунд для этого слишком долго.
    const active = initialData.campaigns.some((c) => c.status === 'running')
    const timer = setInterval(() => router.refresh(), active ? 3_000 : 15_000)
    return () => clearInterval(timer)
  }, [router, initialData.campaigns])

  // Аудиторию считаем здесь, а не на сервере при рендере страницы: перебор
  // всей переписки занимает секунды и раньше держал открытие «Рассылок»
  // до обрыва соединения. Пока число едет — в карточке стоит «…».
  //
  // requestSeq защищает от гонки: быстрый повторный клик по «Кто купил» /
  // «Всем» шлёт новый запрос раньше, чем ответит предыдущий — без проверки
  // «это ещё актуальный запрос?» медленный старый ответ мог прийти позже
  // быстрого нового и переписать eligibleCount неверным числом (в UI это
  // выглядело как «то 9, то 0» при переключении кнопок).
  useEffect(() => {
    const seq = ++requestSeq.current
    const timer = setTimeout(() => {
      setCountLoading(true)
      getEligibleCountForRange(dateFrom || undefined, dateTo || undefined, audience)
        .then((count) => { if (seq === requestSeq.current) setEligibleCount(count) })
        .finally(() => { if (seq === requestSeq.current) setCountLoading(false) })
    }, 400)
    return () => clearTimeout(timer)
  }, [dateFrom, dateTo, audience])

  const scheduleLabel = useMemo(() => {
    const date = new Date(scheduledAt)
    return Number.isNaN(date.getTime()) ? 'Выберите время' : formatDate(date.toISOString())
  }, [scheduledAt])

  function submit() {
    startTransition(async () => {
      const result = await scheduleCampaign({
        title,
        message,
        voiceId: voiceId || undefined,
        scheduledAt: new Date(scheduledAt).toISOString(),
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        audience,
      })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success(`Рассылка запланирована для ${result.count} клиентов`)
      setTitle('')
      setMessage('')
      setVoiceId('')
      setScheduledAt(defaultSchedule())
      setDateFrom('')
      setDateTo('')
      setAudience('not_purchased')
      router.refresh()
    })
  }

  function cancel(id: string) {
    startTransition(async () => {
      const result = await cancelCampaign(id)
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success('Рассылка отменена')
      router.refresh()
    })
  }

  function addOptOut() {
    const phone = optOutPhone.trim()
    if (!phone) return
    startTransition(async () => {
      const result = await addOptOutPhone(phone, optOutReason, optOutBlockBot)
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success(optOutBlockBot ? 'Номер добавлен: рассылки и бот отключены' : 'Номер добавлен в стоп-список рассылок')
      setOptOutPhone('')
      setOptOutReason('')
      setOptOutBlockBot(false)
      router.refresh()
    })
  }

  function removeOptOut(phone: string) {
    startTransition(async () => {
      const result = await removeOptOutPhone(phone)
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success('Номер убран из стоп-списка')
      router.refresh()
    })
  }

  // Пока аудитория не посчитана (eligibleCount === null), планировать нельзя —
  // иначе рассылка уйдёт в неизвестно какое число получателей.
  // Голосовая рассылка может уйти без текста — тогда достаточно выбранного
  // голосового.
  //
  // Раньше незаполненная форма просто гасила кнопку, и было не видно, ЧЕГО
  // не хватает. Теперь считаем причины поимённо: поле подсвечивается красным
  // и под ним пишется, что не так.
  const problems = {
    title: !title.trim() ? 'Введите название — по нему рассылка видна в истории' : null,
    message: !message.trim() && !voiceId ? 'Напишите текст или выберите голосовое' : null,
    // «Время уже прошло» здесь не проверяем: Date.now() в рендере — нечистый
    // вызов, и результат зависел бы от момента отрисовки. Эта проверка живёт
    // в обработчике нажатия, где ей самое место.
    scheduledAt: !scheduledAt
      ? 'Укажите дату и время'
      : Number.isNaN(new Date(scheduledAt).getTime())
        ? 'Некорректная дата'
        : null,
    audience: eligibleCount === null
      ? null
      : eligibleCount === 0
        ? 'Под выбранные фильтры не попал ни один клиент'
        : null,
  }
  const valid = !problems.title && !problems.message && !problems.scheduledAt
    && !problems.audience && (eligibleCount ?? 0) > 0

  // Красную рамку показываем только после первой попытки отправить: подсвечивать
  // пустые поля сразу при открытии формы — это ругань на пустом месте.
  const [attempted, setAttempted] = useState(false)
  const errorOf = (key: keyof typeof problems) => (attempted ? problems[key] : null)
  const fieldStyle = (key: keyof typeof problems) =>
    errorOf(key) ? { borderColor: '#b91c1c', outlineColor: '#b91c1c' } : undefined
  const hint = (key: keyof typeof problems) => {
    const text = errorOf(key)
    return text ? <p className="text-xs font-medium" style={{ color: '#b91c1c' }}>{text}</p> : null
  }

  return (
    <div className="min-h-full" style={{ background: 'var(--surface-2)' }}>
      <PageHeader title="Рассылки" subtitle="Возвращайте клиентов, которые ещё не купили" />
      <main className="mx-auto max-w-6xl p-4 md:p-8">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(280px,.7fr)]">
          <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 md:p-7">
            <div className="mb-6 flex items-start gap-3">
              <div className="flex size-10 items-center justify-center rounded-2xl text-white" style={{ background: 'linear-gradient(145deg,#6f2bd0,#48108f)' }}>
                <Send className="size-5" />
              </div>
              <div>
                <h2 className="text-lg font-bold" style={{ color: 'var(--ink)' }}>Новая рассылка</h2>
                <p className="mt-1 text-sm" style={{ color: 'var(--ink-3)' }}>Сообщение уйдёт в выбранное время по Бишкеку.</p>
              </div>
            </div>

            <div className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="campaign-title">Название для CRM</Label>
                <Input id="campaign-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например: Скидка выходного дня" maxLength={160} style={fieldStyle('title')} />
                {hint('title')}
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="campaign-message">Сообщение клиенту</Label>
                  <span className="text-xs tabular-nums" style={{ color: 'var(--ink-3)' }}>{message.length}/4000</span>
                </div>
                <Textarea id="campaign-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder={voiceId ? 'Необязательно: текст рядом с голосовым…' : 'Напишите текст акции…'} maxLength={4000} className="min-h-44 resize-y leading-relaxed" style={fieldStyle('message')} />
                {hint('message')}
              </div>

              {/* Голосовая рассылка: выбрать и тут же послушать */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Mic className="size-4" style={{ color: 'var(--ink-3)' }} />
                  <Label>Голосовое сообщение</Label>
                </div>
                <div className="space-y-2">
                  {VOICE_MESSAGES.map((voice) => {
                    const active = voiceId === voice.id
                    return (
                      <div
                        key={voice.id}
                        className="rounded-xl p-3 transition-colors"
                        style={{
                          background: active ? '#f1ebfa' : 'var(--surface-2)',
                          border: `1px solid ${active ? '#5115a4' : 'transparent'}`,
                        }}
                      >
                        <label className="flex cursor-pointer items-center gap-2">
                          <input
                            type="radio"
                            name="campaign-voice"
                            className="size-4"
                            checked={active}
                            onChange={() => setVoiceId(voice.id)}
                          />
                          <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{voice.label}</span>
                        </label>
                        {/* Послушать до отправки — клиенту уйдёт ровно это */}
                        <audio controls preload="none" src={voiceSrc(voice)} className="mt-2 w-full" style={{ height: 36 }} />
                      </div>
                    )
                  })}
                  {voiceId && (
                    <button
                      type="button"
                      onClick={() => setVoiceId('')}
                      className="text-xs font-semibold"
                      style={{ color: 'var(--ink-3)' }}
                    >
                      Отправить без голосового
                    </button>
                  )}
                </div>
                <p className="text-xs" style={{ color: 'var(--ink-3)' }}>
                  Голосовое уходит только в WhatsApp по номеру. В Telegram вместо него — текст.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="campaign-time">Дата и время</Label>
                <Input id="campaign-time" type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} style={fieldStyle('scheduledAt')} />
                {hint('scheduledAt')}
              </div>
              <div className="space-y-2">
                <Label>Кому отправлять</Label>
                <div className="flex flex-wrap gap-2">
                  {([
                    ['not_purchased', 'Кто не купил'],
                    ['purchased', 'Кто купил'],
                    ['all', 'Всем'],
                  ] as const).map(([value, label]) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant={audience === value ? 'default' : 'outline'}
                      onClick={() => setAudience(value)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label>Последнее сообщение клиента — период (необязательно)</Label>
                {/* Быстрый выбор периода. У выбранного появляется крестик —
                    им выбор снимается, не трогая остальные кнопки. */}
                <div className="flex flex-wrap items-center gap-2">
                  {[...DATE_PRESETS, ...EXACT_PRESETS].map((item) => {
                    const active = preset === item.key
                    const exact = EXACT_PRESETS.some((e) => e.key === item.key)
                    return (
                      <Button
                        key={item.key}
                        type="button"
                        variant={active ? 'default' : 'outline'}
                        size="sm"
                        className={active ? 'pr-1.5' : undefined}
                        disabled={presetLoading && item.key === 'since_last'}
                        onClick={() => {
                          if (exact) {
                            void applyExactPreset(item.key)
                            return
                          }
                          const dayPreset = DATE_PRESETS.find((d) => d.key === item.key)
                          if (!dayPreset) return
                          setDateFrom(asDateInput(dayPreset.from()))
                          setDateTo(asDateInput(bishkekNow()))
                          setSinceCampaign(null)
                          setPreset(item.key)
                        }}
                      >
                        {item.label}
                        {active && (
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={`Снять выбор «${item.label}»`}
                            title="Снять выбор"
                            className="ml-1.5 inline-flex size-4 items-center justify-center rounded-full transition-colors hover:bg-white/25"
                            onClick={(event) => {
                              // Крестик внутри кнопки: без остановки всплытия
                              // сработал бы и сам пресет, и период выбрался бы
                              // заново вместо того, чтобы сняться.
                              event.stopPropagation()
                              clearPeriod()
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter' && event.key !== ' ') return
                              event.preventDefault()
                              event.stopPropagation()
                              clearPeriod()
                            }}
                          >
                            <X className="size-3" />
                          </span>
                        )}
                      </Button>
                    )
                  })}
                </div>

                {isExactMoment(dateFrom) ? (
                  // Поле type="date" точное время показать не умеет — вместо
                  // пустых полей пишем период словами.
                  <div className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-sm" style={{ background: 'var(--surface-2)' }}>
                    <span style={{ color: 'var(--ink)' }}>
                      Клиенты, писавшие <strong>с {formatMoment(dateFrom)}</strong> по сейчас
                      {sinceCampaign && (
                        <span className="block text-xs" style={{ color: 'var(--ink-3)' }}>
                          от создания рассылки «{sinceCampaign}»
                        </span>
                      )}
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={clearPeriod}>
                      Сбросить
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <Input type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); setPreset(null); setSinceCampaign(null) }} aria-label="От даты" />
                    <span className="text-sm" style={{ color: 'var(--ink-3)' }}>—</span>
                    <Input type="date" value={dateTo} onChange={(event) => { setDateTo(event.target.value); setPreset(null); setSinceCampaign(null) }} aria-label="До даты" />
                    {(dateFrom || dateTo) && (
                      <Button type="button" variant="ghost" size="sm" onClick={clearPeriod}>
                        Сбросить
                      </Button>
                    )}
                  </div>
                )}
                <p className="text-xs" style={{ color: 'var(--ink-3)' }}>
                  Только WhatsApp-канал. Пусто — без фильтра по дате.
                  Кнопки «за N дней» берут сутки Бишкека целиком, с 00:00 до 23:59.
                  «За сутки» и «С прошлой рассылки» считают от точного времени.
                  {preset === 'week' && dateFrom === dateTo && ' Сегодня понедельник — неделя началась сегодня, поэтому период совпадает с «за сегодня».'}
                </p>
              </div>
              <Button
                size="lg"
                className="w-full"
                disabled={pending}
                onClick={() => {
                  setAttempted(true)
                  if (!valid) {
                    const first = Object.values(problems).find(Boolean)
                    toast.error(first ?? 'Заполните форму до конца')
                    return
                  }
                  if (new Date(scheduledAt).getTime() < Date.now() - 60_000) {
                    toast.error('Это время уже прошло — выберите другое')
                    return
                  }
                  submit()
                }}
              >
                <CalendarClock /> {pending ? 'Сохраняем…' : 'Запланировать рассылку'}
              </Button>
            </div>
          </section>

          <aside className="overflow-hidden rounded-3xl text-white shadow-[0_18px_50px_-24px_rgba(78,20,150,.7)]" style={{ background: 'linear-gradient(155deg,#5c18b5 0%,#39106f 100%)' }}>
            <div className="p-6">
              <p className="text-xs font-semibold uppercase tracking-[.16em] text-white/60">Аудитория</p>
              <div className="mt-4 flex items-end gap-2">
                <strong
                  className="text-5xl leading-none tabular-nums"
                  style={{
                    opacity: countLoading || eligibleCount === null ? 0.5 : 1,
                    color: eligibleCount === 0 ? '#ffb4ab' : undefined,
                  }}
                >
                  {eligibleCount ?? '…'}
                </strong>
                <span className="pb-1 text-sm text-white/70">клиентов</span>
              </div>
              {eligibleCount === 0 && (
                <p className="mt-2 rounded-lg px-2.5 py-1.5 text-xs font-medium" style={{ background: 'rgba(255,180,171,0.16)', color: '#ffb4ab' }}>
                  Под эти фильтры никто не попал — рассылать некому. Снимите период
                  или выберите другую аудиторию.
                </p>
              )}
              <p className="mt-3 text-sm leading-relaxed text-white/75">
                {audience === 'not_purchased' && 'Сделки без оплаченного заказа.'}
                {audience === 'purchased' && 'Клиенты с оплаченным заказом.'}
                {audience === 'all' && 'Все клиенты — и купившие, и нет.'}
              </p>
            </div>
            <div className="border-y border-white/10 bg-white/[.06] p-6">
              <div className="flex gap-3"><Clock3 className="mt-0.5 size-4 shrink-0 text-violet-200" /><div><p className="text-xs text-white/55">Отправка</p><p className="mt-1 text-sm font-semibold">{scheduleLabel}</p></div></div>
            </div>
            <div className="space-y-3 p-6 text-sm text-white/75">
              <div className="flex gap-3"><ShieldCheck className="size-4 shrink-0 text-emerald-300" /><span>Купившие автоматически исключены</span></div>
              <div className="flex gap-3"><UsersRound className="size-4 shrink-0 text-emerald-300" /><span>Диалоги менеджеров не затрагиваются</span></div>
              <div className="flex gap-3"><CheckCircle2 className="size-4 shrink-0 text-emerald-300" /><span>Повторная отправка одному клиенту заблокирована</span></div>
            </div>
          </aside>
        </div>

        <RecurringCampaigns rules={initialData.recurring} />

        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-bold" style={{ color: 'var(--ink)' }}>История рассылок</h2>
            <span className="text-xs" style={{ color: 'var(--ink-3)' }}>обновляется автоматически</span>
          </div>
          <div className="space-y-3">
            {initialData.campaigns.length === 0 && (
              <div className="rounded-2xl bg-white px-5 py-10 text-center text-sm ring-1 ring-black/5" style={{ color: 'var(--ink-3)' }}>Рассылок пока нет</div>
            )}
            {initialData.campaigns.map((campaign) => {
              const meta = statusMeta[campaign.status]
              return (
                <article key={campaign.id} className="grid gap-4 rounded-2xl bg-white p-5 ring-1 ring-black/5 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate font-semibold" style={{ color: 'var(--ink)' }}>{campaign.title}</h3>
                      <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ color: meta.color, background: meta.bg }}>{meta.label}</span>
                      {campaign.recurring_id && (
                        <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ color: '#6d28d9', background: '#f0e8ff' }}>
                          Автоматическая
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--ink-3)' }}>
                      Создал: {campaign.author ?? 'неизвестно'}
                    </p>
                    {campaign.message && (
                      <p className="mt-1 text-sm" style={{ color: 'var(--ink-3)' }}>{campaign.message}</p>
                    )}
                    {(() => {
                      const voice = voiceById(campaign.voice_id)
                      if (!voice) return null
                      return (
                        <div className="mt-2">
                          <span className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: '#5115a4' }}>
                            <Mic className="size-3.5" /> {voice.label}
                          </span>
                          <audio controls preload="none" src={voiceSrc(voice)} className="mt-1.5 w-full max-w-sm" style={{ height: 34 }} />
                        </div>
                      )
                    })()}
                  </div>
                  <div className="text-sm tabular-nums md:text-right">
                    <p className="font-semibold" style={{ color: 'var(--ink)' }}>{formatDate(campaign.scheduled_at)}</p>
                    <p className="mt-1 text-xs" style={{ color: 'var(--ink-3)' }}>отправлено {campaign.sent_count}/{campaign.recipient_count}{campaign.failed_count ? ` · ошибок ${campaign.failed_count}` : ''}</p>
                  </div>
                  {campaign.status === 'scheduled' || campaign.status === 'running' ? (
                    <Button variant="outline" size="sm" disabled={pending} onClick={() => cancel(campaign.id)}>
                      <XCircle /> {campaign.status === 'running' ? 'Остановить' : 'Отменить'}
                    </Button>
                  ) : <div className="hidden w-20 md:block" />}

                  {campaign.recipient_count > 0 && (
                    <div className="md:col-span-3">
                      <CampaignProgress
                        campaignId={campaign.id}
                        running={campaign.status === 'running'}
                        sent={campaign.sent_count}
                        total={campaign.recipient_count}
                      />
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        </section>

        <section className="mt-8">
          <div className="mb-3 flex items-center gap-2">
            <ShieldX className="size-4" style={{ color: 'var(--ink-3)' }} />
            <h2 className="text-base font-bold" style={{ color: 'var(--ink)' }}>Стоп-список рассылок</h2>
          </div>
          <p className="mb-3 text-sm" style={{ color: 'var(--ink-3)' }}>
            Номера здесь никогда не попадут в аудиторию рассылки — даже если ещё не купили.
          </p>
          <div className="rounded-2xl bg-white p-5 ring-1 ring-black/5">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
              <Input
                value={optOutPhone}
                onChange={(event) => setOptOutPhone(event.target.value)}
                placeholder="Номер телефона, 996…"
              />
              <Input
                value={optOutReason}
                onChange={(event) => setOptOutReason(event.target.value)}
                placeholder="Причина (необязательно)"
              />
              <Button disabled={!optOutPhone.trim() || pending} onClick={addOptOut}>
                <ShieldX /> Добавить
              </Button>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm" style={{ color: 'var(--ink-2)' }}>
              <input
                type="checkbox"
                checked={optOutBlockBot}
                onChange={(event) => setOptOutBlockBot(event.target.checked)}
                className="size-4 rounded"
              />
              Бот тоже не должен писать этому номеру (даже если он напишет первым)
            </label>

            <div className="mt-4 space-y-2">
              {initialData.optOuts.length === 0 && (
                <p className="py-4 text-center text-sm" style={{ color: 'var(--ink-3)' }}>Стоп-список пуст</p>
              )}
              {initialData.optOuts.map((row) => (
                <div key={row.phone} className="flex items-center justify-between gap-3 rounded-xl px-3 py-2" style={{ background: 'var(--surface-2)' }}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold tabular-nums" style={{ color: 'var(--ink)' }}>+{row.phone}</p>
                      {row.block_bot_replies && (
                        <span className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ color: '#b45309', background: '#fef3c7' }}>
                          <Bot className="size-3" /> бот молчит
                        </span>
                      )}
                    </div>
                    {row.reason && <p className="truncate text-xs" style={{ color: 'var(--ink-3)' }}>{row.reason}</p>}
                  </div>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => removeOptOut(row.phone)}
                    className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                  >
                    <Trash2 className="size-3.5" /> Убрать
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
