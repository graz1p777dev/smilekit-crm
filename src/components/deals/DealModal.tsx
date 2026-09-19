'use client'

import { useEffect, useState, useTransition } from 'react'
import { X, Trash2, MessagesSquare, RefreshCw, Bot, UserRound, ShoppingBag } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import Modal from '../Modal'
import { cn } from '@/lib/utils'
import {
  createDeal,
  updateDeal,
  deleteDeal,
  getDealConversation,
  getDealBotControl,
  setDealBotControl,
  sendDealMessage,
  getDealPurchases,
} from '@/actions/deals'
import type { DealPurchase } from '@/actions/deals'
import type {
  Deal,
  DealCurrency,
  DealEmployee,
  DealMessage,
  DealStage,
  DealViewer,
} from '@/types'
import { DEAL_CURRENCIES, DEAL_SOURCE } from './deal-config'
import ServedBy from './ServedBy'

interface Props {
  deal: Deal | null
  isNew: boolean
  defaultStageId: string
  stages: DealStage[]
  employees: DealEmployee[]
  me: DealViewer
  onClose: () => void
  onSaved: () => void
}

interface FormState {
  title: string
  stage_id: string
  amount: string
  currency: DealCurrency
  customer_name: string
  customer_phone: string
  customer_username: string
  city: string
  address: string
  responsible_employee_id: string
  note: string
}

const AMO_MEDIA_MESSAGE = /^\[([^\]]+)]\s+(https:\/\/\S+)$/i

const ORDER_STATUS_LABELS: Record<string, string> = {
  new: 'новый',
  confirmed: 'подтверждён',
  shipped: 'отправлен',
  delivered: 'доставлен',
  cancelled: 'отменён',
}

function ChatMessageContent({ text, mediaUrl }: { text: string; mediaUrl?: string | null }) {
  if (mediaUrl) {
    return (
      <>
        {text && <span className="mb-1 block">{text}</span>}
        <a href={mediaUrl} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
          📎 Открыть вложение (чек/фото)
        </a>
      </>
    )
  }
  const media = text.match(AMO_MEDIA_MESSAGE)
  if (!media) return text
  const type = media[1].toLowerCase()
  const label = type === 'picture' || type === 'image'
    ? '📷 Открыть фото'
    : type === 'video'
      ? '🎬 Открыть видео'
      : type === 'audio' || type === 'voice'
        ? '🎤 Открыть аудио'
        : '📎 Открыть вложение'
  return (
    <a
      href={media[2]}
      target="_blank"
      rel="noreferrer"
      className="font-medium underline underline-offset-2"
    >
      {label}
    </a>
  )
}

export default function DealModal({
  deal,
  isNew,
  defaultStageId,
  stages,
  employees,
  me,
  onClose,
  onSaved,
}: Props) {
  const [isPending, startTransition] = useTransition()
  const [messages, setMessages] = useState<DealMessage[] | null>(null)
  const [chatNote, setChatNote] = useState<string | null>(null)
  const [conversationReload, setConversationReload] = useState(0)
  const [botControl, setBotControl] = useState<{ chatId: string | null; managerControls: boolean } | null>(null)
  const [togglingBotControl, setTogglingBotControl] = useState(false)
  const [replyText, setReplyText] = useState('')
  const [sendingReply, setSendingReply] = useState(false)
  const [purchases, setPurchases] = useState<DealPurchase[] | null>(null)
  const [purchasesFailed, setPurchasesFailed] = useState(false)
  const [purchasesReload, setPurchasesReload] = useState(0)

  async function handleSendReply() {
    if (!deal || !replyText.trim() || sendingReply) return
    setSendingReply(true)
    const text = replyText.trim()
    const result = await sendDealMessage(deal.id, text)
    setSendingReply(false)
    if (!result.success) {
      toast.error(result.error)
      return
    }
    setReplyText('')
    setMessages((prev) => [
      ...(prev ?? []),
      { id: `local:${Date.now()}`, direction: 'out', sender: 'operator', text, created_at: new Date().toISOString() },
    ])
    setBotControl((prev) => (prev ? { ...prev, managerControls: true } : prev))
  }

  const [form, setForm] = useState<FormState>(() => ({
    title: deal?.title ?? '',
    stage_id: deal?.stage_id ?? defaultStageId,
    amount: deal?.amount !== null && deal?.amount !== undefined ? String(deal.amount) : '',
    currency: deal?.currency ?? 'KGS',
    customer_name: deal?.customer_name ?? '',
    customer_phone: deal?.customer_phone ?? '',
    customer_username: deal?.customer_username ?? '',
    city: deal?.city ?? '',
    address: deal?.address ?? '',
    responsible_employee_id: deal?.responsible_employee_id ?? '',
    note: deal?.note ?? '',
  }))

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  // Что клиент покупал — заказы, привязанные к сделке или к его номеру.
  // С таймаутом: под нагрузкой ответ может не прийти вовсе, и без него
  // блок навсегда застревал на «Загружаем покупки…».
  useEffect(() => {
    if (isNew || !deal) return
    let alive = true
    const timeout = window.setTimeout(() => {
      if (!alive) return
      alive = false
      setPurchases([])
      setPurchasesFailed(true)
    }, 12_000)
    void getDealPurchases(deal.id)
      .then((rows) => {
        if (!alive) return
        window.clearTimeout(timeout)
        setPurchases(rows)
      })
      .catch(() => {
        if (!alive) return
        window.clearTimeout(timeout)
        setPurchases([])
        setPurchasesFailed(true)
      })
    return () => { alive = false; window.clearTimeout(timeout) }
  }, [isNew, deal, purchasesReload])

  // Переписка живёт во внешней системе — тянем её только для открытой сделки.
  useEffect(() => {
    if (isNew || !deal) return
    let alive = true
    const timeout = window.setTimeout(() => {
      if (!alive) return
      alive = false
      setMessages([])
      setChatNote('Сервер не ответил вовремя. Нажмите «Повторить».')
    }, 12_000)
    void getDealConversation(deal.id)
      .then((res) => {
        if (!alive) return
        window.clearTimeout(timeout)
        setMessages(res.messages)
        setChatNote(res.note)
      })
      .catch((error) => {
        if (!alive) return
        window.clearTimeout(timeout)
        console.error('deal conversation load failed', error)
        setMessages([])
        setChatNote('Не удалось загрузить переписку. Нажмите «Повторить».')
      })
    return () => {
      alive = false
      window.clearTimeout(timeout)
    }
  }, [isNew, deal, conversationReload])

  // Тумблер «кто ведёт чат» — только для сделок amoCRM, только когда в чате
  // уже писал живой менеджер (иначе бот и так ведёт диалог, переключать нечего).
  useEffect(() => {
    // Раньше тумблер показывался только для сделок amoCRM. Канал теперь
    // один — WhatsApp через Green API, и ключ чата это номер клиента.
    if (isNew || !deal || !deal.customer_phone) return
    let alive = true
    void getDealBotControl(deal.id).then((status) => {
      if (alive) setBotControl(status)
    })
    return () => {
      alive = false
    }
  }, [isNew, deal, conversationReload])

  const handleToggleBotControl = async () => {
    if (!botControl?.chatId) return
    const nextBotEnabled = botControl.managerControls // сейчас у менеджера → включаем бота
    setTogglingBotControl(true)
    // Сервер иногда не отвечает вовсе (см. BotToggle.tsx) — без таймаута
    // кнопка оставалась disabled до перезагрузки страницы.
    const timedOut = Symbol('timeout')
    const res = await Promise.race([
      setDealBotControl(botControl.chatId, nextBotEnabled),
      new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), 10_000)),
    ])
    setTogglingBotControl(false)
    if (res === timedOut) {
      toast.error('Сервер не ответил — попробуйте ещё раз через несколько секунд')
      return
    }
    if (!res.success) {
      toast.error(res.error)
      return
    }
    setBotControl({ ...botControl, managerControls: !nextBotEnabled })
    toast.success(nextBotEnabled ? 'Чат передан боту' : 'Управление чатом у вас — бот не отвечает')
  }

  const handleSave = () => {
    if (!form.title.trim()) {
      toast.error('Введите название сделки')
      return
    }
    const amount = form.amount.trim() ? Number(form.amount.replace(',', '.')) : null
    if (amount !== null && !Number.isFinite(amount)) {
      toast.error('Сумма должна быть числом')
      return
    }

    const payload = {
      title: form.title,
      stage_id: form.stage_id,
      amount,
      currency: form.currency,
      customer_name: form.customer_name || null,
      customer_phone: form.customer_phone || null,
      customer_username: form.customer_username || null,
      city: form.city || null,
      address: form.address || null,
      responsible_employee_id: form.responsible_employee_id || null,
      note: form.note || null,
    }

    startTransition(async () => {
      const res = isNew ? await createDeal(payload) : await updateDeal(deal!.id, payload)
      if (res.success) {
        toast.success(isNew ? 'Сделка создана' : 'Изменения сохранены')
        onSaved()
        onClose()
      } else {
        toast.error(res.error)
      }
    })
  }

  const handleDelete = () => {
    if (!deal) return
    startTransition(async () => {
      const res = await deleteDeal(deal.id)
      if (res.success) {
        toast.success('Сделка удалена')
        onSaved()
        onClose()
      } else {
        toast.error(res.error)
      }
    })
  }

  // Отменённые заказы в итог не идут — это не покупка.
  const paidPurchases = (purchases ?? []).filter((p) => p.status !== 'cancelled')
  const purchasesTotal = paidPurchases.reduce((sum, p) => sum + Number(p.total_amount ?? 0), 0)
  const purchasesBoxes = paidPurchases.reduce((sum, p) => sum + (p.quantity ?? 0), 0)

  const source = deal ? DEAL_SOURCE[deal.source] : DEAL_SOURCE.manual
  const SourceIcon = source.icon

  return (
    <Modal onClose={onClose} variant="right">
      <div className="flex h-[100dvh] w-[min(760px,100vw)] flex-col overflow-hidden bg-white shadow-2xl animate-in slide-in-from-right duration-200">
        {/* Шапка */}
        <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5 md:px-6 md:py-4">
          <div className="flex items-center gap-2.5">
            <h2 className="text-base font-bold text-gray-900">
              {isNew ? 'Новая сделка' : 'Сделка'}
            </h2>
            {!isNew && (
              <span
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                style={{ color: source.color, background: source.bg }}
              >
                <SourceIcon size={11} />
                {source.label}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="-mr-2 rounded-lg p-2.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 md:mr-0 md:p-1.5"
            aria-label="Закрыть"
          >
            <X size={18} />
          </button>
        </div>

        {/* Тело */}
        {/* На телефоне поля и выпадающие списки 40px — под палец. */}
        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 scroll-hidden max-md:[&_[data-slot=input]]:h-10 max-md:[&_[data-slot=select-trigger]]:h-10 max-md:[&_[data-slot=select-trigger]]:w-full md:px-6 md:py-5">
          <div className="space-y-1.5">
            <Label>Название</Label>
            <Input
              // Существующую сделку на телефоне открывают читать переписку —
              // клавиатура сразу не нужна; для новой фокус в названии.
              autoFocus={isNew}
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="Например: Smilekit, 2 коробки — клиент из Telegram"
              maxLength={300}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Этап</Label>
              <Select value={form.stage_id} onValueChange={(v) => set('stage_id', v as string)}>
                {/* Base UI Select без children показывает сырой value (UUID) —
                    имя этапа рендерим явно. */}
                <SelectTrigger>
                  <SelectValue>
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: stages.find((s) => s.id === form.stage_id)?.color ?? '#d1d5db' }}
                        aria-hidden
                      />
                      {stages.find((s) => s.id === form.stage_id)?.name ?? 'Выберите этап'}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="flex items-center gap-2">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: s.color }}
                          aria-hidden
                        />
                        {s.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Ответственный</Label>
              <Select
                value={form.responsible_employee_id || 'none'}
                onValueChange={(v) => set('responsible_employee_id', v === 'none' ? '' : (v as string))}
              >
                <SelectTrigger>
                  <SelectValue>
                    {employees.find((e) => e.id === form.responsible_employee_id)?.name ?? 'Не назначен'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Не назначен</SelectItem>
                  {employees.map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="space-y-1.5">
              <Label>Сумма</Label>
              <Input
                value={form.amount}
                onChange={(e) => set('amount', e.target.value)}
                placeholder="Пока не известна"
                inputMode="decimal"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Валюта</Label>
              <Select
                value={form.currency}
                onValueChange={(v) => set('currency', v as DealCurrency)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DEAL_CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Клиент</Label>
              <Input
                value={form.customer_name}
                onChange={(e) => set('customer_name', e.target.value)}
                placeholder="Имя"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Телефон</Label>
              <Input
                value={form.customer_phone}
                onChange={(e) => set('customer_phone', e.target.value)}
                placeholder="996…"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Ник</Label>
              <Input
                value={form.customer_username}
                onChange={(e) => set('customer_username', e.target.value)}
                placeholder="@username"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[180px_1fr]">
            <div className="space-y-1.5">
              <Label>Город</Label>
              <Input
                value={form.city}
                onChange={(e) => set('city', e.target.value)}
                placeholder="Бишкек"
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Адрес</Label>
              <Input
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
                placeholder="Улица, дом, квартира"
                maxLength={500}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Заметка</Label>
            <Textarea
              value={form.note}
              onChange={(e) => set('note', e.target.value)}
              placeholder="Что обсудили, о чём договорились…"
              rows={3}
            />
          </div>

          {/* Что покупал — история заказов этого клиента */}
          {!isNew && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <ShoppingBag size={14} className="text-gray-400" />
                <Label>Покупки</Label>
                {purchasesTotal > 0 && (
                  <span className="text-[11px] font-semibold text-[#5115a4]">
                    {purchasesBoxes} кор. · {purchasesTotal.toLocaleString('ru-RU')} сом
                  </span>
                )}
              </div>
              {purchases === null ? (
                <p className="text-[12px] text-gray-400">Загружаем покупки…</p>
              ) : purchases.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-200 px-4 py-3 text-center text-[12px] text-gray-400">
                  <span>{purchasesFailed ? 'Сервер не ответил вовремя.' : 'Ещё ничего не покупал'}</span>
                  {purchasesFailed && (
                    <button
                      type="button"
                      onClick={() => {
                        setPurchases(null)
                        setPurchasesFailed(false)
                        setPurchasesReload((value) => value + 1)
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#f1ebfa] px-3 py-1.5 font-semibold text-[#5115a4] transition-colors hover:bg-[#e7dcf6]"
                    >
                      <RefreshCw size={13} />
                      Повторить
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {purchases.map((p) => (
                    <div key={p.id} className="rounded-xl bg-gray-50/70 px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[12px]">
                        <span className="text-gray-500">
                          {new Date(p.created_at).toLocaleDateString('ru-RU')}
                        </span>
                        <span className="font-medium text-gray-900">
                          {p.quantity ? `${p.quantity} кор.` : '— кор.'}
                        </span>
                        <span className="font-medium text-gray-900">
                          {p.total_amount !== null
                            ? `${Number(p.total_amount).toLocaleString('ru-RU')} ${p.currency}`
                            : '—'}
                        </span>
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                          style={
                            p.status === 'cancelled'
                              ? { background: '#fee2e2', color: '#b91c1c' }
                              : p.status === 'delivered'
                                ? { background: '#dcfce7', color: '#15803d' }
                                : { background: '#f1ebfa', color: '#5115a4' }
                          }
                        >
                          {ORDER_STATUS_LABELS[p.status] ?? p.status}
                        </span>
                      </div>
                      {p.summary && (
                        <p className="mt-1 text-[11px] leading-snug text-gray-500">{p.summary}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!isNew && deal && <ServedBy dealId={deal.id} />}

          {/* Переписка — только чтение, вести её продолжают там, где начали */}
          {!isNew && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <MessagesSquare size={14} className="text-gray-400" />
                  <Label>Переписка</Label>
                </div>
                {/* Тумблер появляется только когда в чате уже есть сообщение
                    менеджера (или его вернули боту) — до этого бот и так
                    отвечает сам, переключать нечего. */}
                {botControl?.chatId && (
                  <button
                    type="button"
                    onClick={handleToggleBotControl}
                    disabled={togglingBotControl}
                    title={
                      botControl.managerControls
                        ? 'Сейчас чат ведёте вы — нажмите, чтобы вернуть боту'
                        : 'Сейчас отвечает бот — нажмите, чтобы забрать чат себе'
                    }
                    className={cn(
                      'flex min-h-9 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:opacity-60 md:min-h-0',
                      botControl.managerControls
                        ? 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                        : 'bg-[#f1ebfa] text-[#5115a4] hover:bg-[#e7dcf6]'
                    )}
                  >
                    {botControl.managerControls ? <UserRound size={12} /> : <Bot size={12} />}
                    {botControl.managerControls ? 'Ведёте вы — вернуть боту' : 'Ведёт бот — забрать себе'}
                  </button>
                )}
              </div>
              {messages === null ? (
                <p className="text-[12px] text-gray-400">Загружаем диалог…</p>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-200 px-4 py-5 text-center text-[12px] text-gray-400">
                  <span>{chatNote ?? 'Переписки нет'}</span>
                  {chatNote?.includes('Повторить') && (
                    <button
                      type="button"
                      onClick={() => {
                        setMessages(null)
                        setChatNote(null)
                        setConversationReload((value) => value + 1)
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#f1ebfa] px-3 py-1.5 font-semibold text-[#5115a4] transition-colors hover:bg-[#e7dcf6]"
                    >
                      <RefreshCw size={13} />
                      Повторить
                    </button>
                  )}
                </div>
              ) : (
                <div className="max-h-[42vh] space-y-1.5 overflow-y-auto rounded-xl bg-gray-50/70 p-3 scroll-hidden">
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={cn(
                        'max-w-[85%] rounded-xl px-3 py-1.5 text-[12px] leading-snug whitespace-pre-wrap',
                        m.direction === 'in'
                          ? 'bg-white text-gray-700 shadow-sm'
                          : 'ml-auto text-white brand-gradient'
                      )}
                    >
                      {m.direction === 'out' && (m.sender === 'bot' || m.sender === 'operator') && (
                        <span className="mb-0.5 block text-[10px] font-semibold opacity-80">
                          {m.sender === 'bot' ? '🤖 Бот' : '👤 Менеджер'}
                        </span>
                      )}
                      <ChatMessageContent text={m.text} mediaUrl={m.media_url} />
                    </div>
                  ))}
                </div>
              )}
              {messages !== null && (
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    value={replyText}
                    onChange={(event) => setReplyText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        handleSendReply()
                      }
                    }}
                    // Клавиатура телефона поднимается не сразу — после неё
                    // возвращаем поле ответа в видимую часть карточки.
                    onFocus={(event) => {
                      const field = event.currentTarget
                      window.setTimeout(() => field.scrollIntoView({ block: 'nearest' }), 300)
                    }}
                    placeholder="Написать клиенту…"
                    disabled={sendingReply}
                    className="text-base md:text-[13px]"
                    enterKeyHint="send"
                  />
                  <Button size="sm" className="h-10 px-3 md:h-7" onClick={handleSendReply} disabled={sendingReply || !replyText.trim()}>
                    {sendingReply ? '…' : 'Отправить'}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Низ */}
        <div className="flex items-center justify-between gap-3 border-t border-gray-100 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6 md:py-4">
          {!isNew && me.role === 'owner' ? (
            <button
              onClick={handleDelete}
              disabled={isPending}
              className="flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-gray-400 md:min-h-0 transition-colors hover:bg-[#f1ebfa] hover:text-[#5115a4] disabled:opacity-50"
            >
              <Trash2 size={15} />
              Удалить
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" className="h-10 md:h-8" onClick={onClose} disabled={isPending}>
              Отмена
            </Button>
            <Button className="h-10 md:h-8" onClick={handleSave} disabled={isPending}>
              {isPending ? 'Сохраняем…' : isNew ? 'Создать' : 'Сохранить'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
