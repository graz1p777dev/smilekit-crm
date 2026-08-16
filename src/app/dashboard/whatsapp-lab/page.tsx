'use client'

// Песочница для теста РЕАЛЬНОГО WhatsApp-пайплайна (Green API): в отличие
// от /dashboard/laboratory (только AI-ядро без сценариев), здесь работает
// тот же самый bot-reply.ts, что обрабатывает настоящих клиентов — скрипт
// продаж, блок результата с фото, доставка по городу, QR оплаты, свои
// правила, follow-up-скидка. Изолировано: тестовый chat_id не пересекается
// с реальными номерами, сделки в воронке не создаются, реальный Green API
// не дёргается — независимо от того, включён ли бот аварийным выключателем
// для настоящих клиентов.

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Clock, FlaskConical, Mic, RotateCcw, Send, ShieldAlert, User, Bot as BotIcon, Image as ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { sendWhatsappLabMessage, triggerWhatsappLabFollowup, type WhatsappLabMessage } from '@/actions/whatsapp-lab'

const MEDIA_MARKERS = new Set(['[QR оплаты]', '[фото результата]'])

function isMediaMarker(text: string): boolean {
  return MEDIA_MARKERS.has(text)
}

export default function WhatsappLabPage() {
  const [chatId, setChatId] = useState<string | undefined>(undefined)
  const [history, setHistory] = useState<WhatsappLabMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [history, loading])

  async function send() {
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    setLoading(true)
    // Оптимистично добавляем сообщение клиента — бот отвечает не мгновенно
    // (те же паузы между репликами и фото, что в реальном WhatsApp).
    setHistory((prev) => [...prev, { sender: 'client', text, createdAt: new Date().toISOString(), isVoice: false }])
    try {
      const result = await sendWhatsappLabMessage(chatId, text)
      if (!result.success) {
        toast.error(result.error)
        setHistory((prev) => prev.slice(0, -1))
        return
      }
      setChatId(result.chatId)
      setHistory(result.history)
    } finally {
      setLoading(false)
    }
  }

  function reset() {
    setChatId(undefined)
    setHistory([])
    setInput('')
  }

  async function skipToFollowup() {
    if (!chatId || loading) return
    setLoading(true)
    try {
      const result = await triggerWhatsappLabFollowup(chatId)
      if (!result.success) {
        toast.error(result.error)
        return
      }
      setHistory(result.history)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-5 p-4 md:p-8" style={{ maxWidth: 780 }}>
      <div>
        <div className="kicker">WhatsApp (Green API)</div>
        <h1 className="block-title" style={{ marginTop: 7 }}>
          Лаборатория WhatsApp
        </h1>
      </div>

      <div
        className="flex items-start gap-2.5 rounded-2xl px-4 py-3"
        style={{ background: 'var(--brand-soft)' }}
      >
        <ShieldAlert size={16} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--brand-ink)' }} />
        <p className="text-xs leading-relaxed" style={{ color: 'var(--brand-ink)' }}>
          Работает тот же код, что отвечает настоящим клиентам в WhatsApp — включая блок результата с фото, доставку
          по городу, QR оплаты и правила из настроек. Отличие только в изоляции: тестовый номер не пересекается с
          реальными, сделка в воронке не создаётся, реальный Green API не дёргается — можно тестировать, даже когда
          общий выключатель бота выключен для настоящих клиентов. Вопрос «вам оформить?» после блока результата в
          реальном WhatsApp приходит только через 5 минут молчания — кнопка «Промотать 5 минут» показывает его сразу.
        </p>
      </div>

      <div className="overflow-hidden rounded-2xl bg-white" style={{ border: '1px solid var(--line)' }}>
        <div className="flex items-center justify-between gap-2.5 px-5 py-4" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl" style={{ backgroundColor: 'var(--brand-ink)' }}>
              <FlaskConical size={15} color="#fff" />
            </div>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>Тестовый чат</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" className="gap-1.5" disabled={!chatId || loading} onClick={() => void skipToFollowup()}>
              <Clock size={14} />
              Промотать 5 минут
            </Button>
            <Button variant="ghost" size="sm" className="gap-1.5" disabled={history.length === 0 || loading} onClick={reset}>
              <RotateCcw size={14} />
              Сбросить
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-3 px-5 py-5" style={{ minHeight: 320, maxHeight: 560, overflowY: 'auto' }}>
          {history.length === 0 && (
            <p className="text-sm" style={{ color: 'var(--ink-3)' }}>
              Напишите первое сообщение — как будто вы клиент, который только что написал боту в WhatsApp.
            </p>
          )}
          {history.map((message, index) => (
            <ChatBubble key={index} message={message} />
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--ink-3)' }}>
              <BotIcon size={14} /> печатает…
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="flex items-end gap-2 px-5 py-4" style={{ borderTop: '1px solid var(--line)' }}>
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder="Сообщение как от клиента…"
            className="min-h-[44px] flex-1 resize-none"
            disabled={loading}
          />
          <Button onClick={() => void send()} disabled={loading || !input.trim()} size="icon">
            <Send size={16} />
          </Button>
        </div>
      </div>
    </div>
  )
}

function ChatBubble({ message }: { message: WhatsappLabMessage }) {
  const isClient = message.sender === 'client'
  const media = isMediaMarker(message.text)
  return (
    <div className={`flex gap-2.5 ${isClient ? 'flex-row-reverse' : ''}`}>
      <div
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: isClient ? 'var(--ink-3)' : 'var(--brand-ink)' }}
      >
        {isClient ? <User size={13} color="#fff" /> : <BotIcon size={13} color="#fff" />}
      </div>
      <div
        className="max-w-[75%] rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap"
        style={{
          background: isClient ? 'var(--brand-soft)' : 'var(--surface, #f7f5f5)',
          color: 'var(--ink)',
        }}
      >
        {media ? (
          <span className="flex items-center gap-1.5" style={{ color: 'var(--ink-3)' }}>
            <ImageIcon size={14} /> {message.text}
          </span>
        ) : message.isVoice ? (
          <span className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--brand-ink)' }}>
              <Mic size={13} /> голосовое сообщение
            </span>
            <span style={{ color: 'var(--ink-3)' }}>{message.text}</span>
          </span>
        ) : (
          message.text
        )}
      </div>
    </div>
  )
}
