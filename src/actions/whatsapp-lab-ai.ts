'use server'

// Тестовый ИИ-режим «Лаборатории»: та же песочница, что whatsapp-lab.ts, но
// вместо жёсткого regex-роутинга и готовых шаблонов bot-reply.ts — модель
// сама формулирует ответ по инструкции (см. ai-lab-prompt.ts). Полностью
// изолировано от bot-reply.ts и от реальных клиентов: своя история в той же
// таблице, но под отдельным префиксом chat_id (ai-lab-...), чтобы никогда не
// пересечься ни с настоящими номерами, ни с обычными тестовыми чатами
// (lab-...).

import { randomUUID } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { AI_LAB_SYSTEM_PROMPT } from '@/lib/greenapi/ai-lab-prompt'
import { requireOwner } from '@/actions/whatsapp-settings'
import type { WhatsappLabMessage } from '@/actions/whatsapp-lab'

function newAiLabChatId(): string {
  return `ai-lab-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

interface DeepSeekResponse {
  choices?: { message?: { content?: string } }[]
}

// Метки, которыми модель сама размечает медиа/события в тексте ответа — тот
// же принцип, что и в реальном боте (текст + отдельная отправка медиа), но
// здесь решение, что и когда показать, принимает сама модель, а не regex.
const MARKERS: { tag: string; display: string }[] = [
  { tag: '[QR]', display: '[QR оплаты]' },
  { tag: '[ФОТО_РЕЗУЛЬТАТ]', display: '[фото результата]' },
]
const ORDER_PLACED_TAG = '[ЗАКАЗ_ОФОРМЛЕН]'

async function loadAiLabHistory(chatId: string): Promise<WhatsappLabMessage[]> {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('amocrm_messages')
    .select('sender, text, created_at')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true })
    .limit(200)
  return (data ?? []).map((row) => {
    const r = row as { sender: string; text: string; created_at: string }
    return { sender: r.sender as 'client' | 'bot', text: r.text, createdAt: r.created_at, isVoice: false }
  })
}

export type SendWhatsappLabAiMessageResult =
  | { success: true; chatId: string; history: WhatsappLabMessage[] }
  | { success: false; error: string }

export async function sendWhatsappLabAiMessage(
  chatId: string | undefined,
  text: string
): Promise<SendWhatsappLabAiMessageResult> {
  if (!(await requireOwner())) return { success: false, error: 'Доступно только владельцу' }
  const trimmed = text.trim()
  if (!trimmed) return { success: false, error: 'Введите сообщение' }
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) return { success: false, error: 'DEEPSEEK_API_KEY не задан' }

  const effectiveChatId = chatId || newAiLabChatId()
  const supabase = createAdminClient()
  const priorHistory = await loadAiLabHistory(effectiveChatId)

  await supabase.from('amocrm_messages').insert({
    amo_message_id: `ai-lab:${randomUUID()}`,
    chat_id: effectiveChatId,
    direction: 'in',
    sender: 'client',
    text: trimmed,
  })

  const messages = [
    { role: 'system', content: AI_LAB_SYSTEM_PROMPT },
    ...priorHistory.map((m) => ({ role: m.sender === 'client' ? 'user' : 'assistant', content: m.text })),
    { role: 'user', content: trimmed },
  ]

  let content: string
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', messages, temperature: 0.7 }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return { success: false, error: `DeepSeek: HTTP ${res.status}` }
    const data = (await res.json()) as DeepSeekResponse
    content = data.choices?.[0]?.message?.content?.trim() ?? ''
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Ошибка ИИ' }
  }
  if (!content) return { success: false, error: 'Пустой ответ ИИ' }

  const orderPlaced = content.includes(ORDER_PLACED_TAG)
  let displayText = content.replace(ORDER_PLACED_TAG, '').trim()
  const parts: string[] = []
  for (const marker of MARKERS) {
    if (displayText.includes(marker.tag)) {
      const [before, after] = displayText.split(marker.tag)
      if (before.trim()) parts.push(before.trim())
      parts.push(marker.display)
      displayText = after ?? ''
    }
  }
  if (displayText.trim()) parts.push(displayText.trim())
  if (orderPlaced) parts.push('[тестовый заказ оформлен — реальная сделка не создана]')

  const rows = parts.map((part) => ({
    amo_message_id: `ai-lab:bot:${randomUUID()}`,
    chat_id: effectiveChatId,
    direction: 'out' as const,
    sender: 'bot' as const,
    text: part,
  }))
  if (rows.length) await supabase.from('amocrm_messages').insert(rows)

  return { success: true, chatId: effectiveChatId, history: await loadAiLabHistory(effectiveChatId) }
}
