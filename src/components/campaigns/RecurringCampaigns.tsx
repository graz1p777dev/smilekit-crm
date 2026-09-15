'use client'

// Автоматические рассылки: правило, которое само создаёт обычную рассылку
// каждые N дней в заданное время. Сами отправки уходят в общую историю —
// там они помечены как автоматические.

import { useState, useTransition } from 'react'
import { Plus, Power, Repeat, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import {
  deleteRecurringCampaign,
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

/** За какой срок брать клиентов по их последнему сообщению. */
const WINDOWS: { days: number | null; label: string }[] = [
  { days: 1, label: 'только сегодняшние' },
  { days: 7, label: 'за последнюю неделю' },
  { days: 30, label: 'за последний месяц' },
  { days: null, label: 'без ограничения' },
]

export default function RecurringCampaigns({ rules }: { rules: RecurringCampaignRow[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)

  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [audience, setAudience] = useState<CampaignAudience>('not_purchased')
  const [intervalDays, setIntervalDays] = useState(1)
  const [sendAtTime, setSendAtTime] = useState('12:00')
  const [windowDays, setWindowDays] = useState<number | null>(1)

  function save() {
    if (!title.trim()) return toast.error('Введите название')
    if (!message.trim() && !voiceId) return toast.error('Напишите текст или выберите голосовое')

    startTransition(async () => {
      const result = await saveRecurringCampaign({
        title, message, voiceId: voiceId || undefined,
        audience, intervalDays, sendAtTime, windowDays,
      })
      if (!result.success) return void toast.error(result.error)
      toast.success('Автоматическая рассылка создана')
      setTitle(''); setMessage(''); setVoiceId(''); setOpen(false)
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
        <div className="mb-4 space-y-4 rounded-2xl bg-white p-5 ring-1 ring-black/5">
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
                <button type="button" onClick={() => setVoiceId('')} className="text-xs font-semibold" style={{ color: 'var(--ink-3)' }}>
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
              {WINDOWS.map((item) => (
                <Button
                  key={String(item.days)}
                  type="button"
                  size="sm"
                  variant={windowDays === item.days ? 'default' : 'outline'}
                  onClick={() => setWindowDays(item.days)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </div>

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
          const window = WINDOWS.find((item) => item.days === rule.window_days)
          return (
            <article key={rule.id} className="rounded-2xl bg-white p-5 ring-1 ring-black/5">
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
                {AUDIENCE_LABELS[rule.audience]} · {window?.label ?? 'без ограничения'}
                {rule.last_run_at && ` · последний запуск ${new Date(rule.last_run_at).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`}
              </p>
              <p className="mt-1 text-xs" style={{ color: 'var(--ink-3)' }}>
                Создал: <strong style={{ color: 'var(--ink-2)' }}>{rule.author ?? 'неизвестно'}</strong>
              </p>

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
