// Локальный ИИ-помощник CRM.
//
// Страница /dashboard/copilot — наследие форка DemiResults: она ходила через
// /api/backend в их FastAPI-бэкенд (/copilot/chat), которого у SmileKit нет —
// BOT_BACKEND_API_URL не задан, прокси бился в localhost:8000, помощник не
// работал никогда. Вместо несуществующего бэкенда отвечаем прямо здесь через
// DeepSeek. Контракт ответа повторяет старый бэкенд, страница не менялась.

import { recordUsage } from '@/lib/control-center'

interface CopilotMessage {
  role: 'user' | 'assistant'
  content: string
}

// История диалогов в памяти процесса (один инстанс Railway). Пропадает при
// рестарте — для помощника-справочника это приемлемо.
const conversations = new Map<number, CopilotMessage[]>()
let nextConversationId = 1

const SYSTEM_PROMPT = `Ты — ИИ-помощник CRM-системы SmileKit (продажа отбеливающих полосок для зубов, Кыргызстан).
Помогаешь сотрудникам разобраться с системой и отвечаешь на рабочие вопросы. Отвечай кратко, по-русски, дружелюбно.

Что есть в CRM (разделы меню):
- Дашборд — сводка.
- Сделки — воронка продаж (канбан). Сделки создаются автоматически из Telegram-бота, WhatsApp (amoCRM) и вручную. В карточке сделки видна переписка с бейджами Бот/Менеджер. В шапке доски — кнопка «Бот: ВКЛ/ВЫКЛ» (аварийный выключатель ответов бота в WhatsApp-чатах amoCRM; выключен — бот молчит, но история и этапы ведутся). Кнопка «Синхронизировать» подтягивает лиды из amoCRM.
- Заказы — заказы из Telegram-бота.
- Аналитика бота, Отчёты бота — статистика работы ИИ-бота.
- Настройки бота — промпты менеджера и супервизора, модель. Меняются без передеплоя.
- Лаборатория — тестовый чат с ботом, клиентам ничего не уходит.
- Декомпозиция, Зарплата, Финансы, Маркетинг, Задачи, Сотрудники, Календарь, Уведомления, Документы, Настройки (этапы воронки, роли).

Про ботов: Telegram-бот SmileKit ведёт клиентов по скрипту продаж (цена 1490 сом, скидки, доставка, оплата по QR, проверка чека). В WhatsApp клиенты пишут через amoCRM — отвечает тот же ИИ. Если в чате ответил живой менеджер, бот этот чат больше не трогает.

Если вопрос не про CRM — отвечай как обычный полезный ассистент. Если не знаешь точного ответа про систему — честно скажи и предложи обратиться к владельцу.`

interface DeepSeekResponse {
  choices?: { message?: { content?: string } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export interface CopilotChatResult {
  conversation_id: number
  message: {
    id: string
    role: 'assistant'
    content: string
    buttons: never[]
    created_at: string
  }
  pending_action: null
}

export async function localCopilotChat(
  userMessage: string,
  conversationId: number | null,
  pageContext: { path?: string } | null
): Promise<CopilotChatResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY не задан')

  const id = conversationId ?? nextConversationId++
  const history = conversations.get(id) ?? []

  const contextNote = pageContext?.path ? `\n\n(Пользователь сейчас на странице ${pageContext.path})` : ''
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-20),
    { role: 'user', content: `${userMessage}${contextNote}` },
  ]

  const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      // Справочные ответы — рассуждения не нужны, а на V4 thinking может
      // съесть весь лимит (см. ПЕРЕДАЧА-ПРОГРАММИСТУ.md, грабля №8).
      thinking: { type: 'disabled' },
      temperature: 0.4,
      max_tokens: 2000,
      stream: false,
    }),
  })
  if (!res.ok) throw new Error(`DeepSeek: HTTP ${res.status}`)
  const data = (await res.json()) as DeepSeekResponse
  if (data.usage) {
    recordUsage({
      provider: 'deepseek',
      model,
      inputTokens: data.usage.prompt_tokens ?? 0,
      outputTokens: data.usage.completion_tokens ?? 0,
    })
  }
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) throw new Error('DeepSeek вернул пустой ответ')

  history.push({ role: 'user', content: userMessage }, { role: 'assistant', content })
  conversations.set(id, history.slice(-40))

  return {
    conversation_id: id,
    message: {
      id: `copilot-${Date.now()}`,
      role: 'assistant',
      content,
      buttons: [],
      created_at: new Date().toISOString(),
    },
    pending_action: null,
  }
}
