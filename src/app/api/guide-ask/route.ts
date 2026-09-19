// Помощник на странице инструкции (/instrukciya.html).
//
// GET  — вошёл ли пользователь в CRM (виджет показывает «Войдите» или поле
//        вопроса). Страница инструкции публичная, но спрашивать ИИ могут
//        только сотрудники: запросы к модели стоят денег.
// POST — { question, history? } → { answer }. Отвечает строго по тексту
//        инструкции (src/lib/guide/guide-text.ts), моделью DeepSeek.

import { NextResponse, type NextRequest } from 'next/server'
import { currentViewer } from '@/lib/auth-guards'
import { checkRateLimit } from '@/lib/rate-limit'
import { recordUsage } from '@/lib/control-center'
import { guideText } from '@/lib/guide/guide-text'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_QUESTION = 1000
const MAX_HISTORY = 6

const SYSTEM_PROMPT = `Ты — помощник по CRM SmileKit. Сотрудник читает инструкцию и задаёт вопрос.
Правила:
- Отвечай ТОЛЬКО по тексту инструкции ниже. Не придумывай кнопок, страниц и функций, которых там нет.
- Если в инструкции ответа нет — так и скажи и посоветуй спросить владельца.
- Пиши по-русски, коротко и по шагам («1. Откройте… 2. Нажмите…»), называй кнопки и разделы так, как они названы в инструкции.
- Без медицинских и стоматологических советов, без обещаний результата отбеливания.
- Никаких паролей, ключей и технических деталей сервера.

ИНСТРУКЦИЯ:
`

export async function GET() {
  const viewer = await currentViewer()
  return NextResponse.json({ authenticated: Boolean(viewer), name: viewer?.name ?? null })
}

interface HistoryItem { role: 'user' | 'assistant'; content: string }

export async function POST(request: NextRequest) {
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ error: 'Войдите в CRM, чтобы спросить помощника' }, { status: 401 })

  const limit = checkRateLimit(`guide-ask:${viewer.id}`, { windowMs: 10 * 60_000, max: 30 })
  if (!limit.allowed) {
    return NextResponse.json({ error: 'Слишком много вопросов подряд — подождите пару минут' }, { status: 429 })
  }

  const body = (await request.json().catch(() => null)) as { question?: unknown; history?: unknown } | null
  const question = typeof body?.question === 'string' ? body.question.trim().slice(0, MAX_QUESTION) : ''
  if (!question) return NextResponse.json({ error: 'Напишите вопрос' }, { status: 400 })
  const history: HistoryItem[] = Array.isArray(body?.history)
    ? (body.history as HistoryItem[])
        .filter((h) => (h?.role === 'user' || h?.role === 'assistant') && typeof h.content === 'string')
        .slice(-MAX_HISTORY)
        .map((h) => ({ role: h.role, content: h.content.slice(0, 2000) }))
    : []

  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'Помощник не настроен' }, { status: 503 })
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-flash'

  let response: Response
  try {
    response = await fetch(`${process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT + (await guideText()) },
          ...history,
          { role: 'user', content: question },
        ],
        temperature: 0.2,
        max_tokens: 900,
        // Рассуждения модели съедают лимит ответа — здесь они не нужны.
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.timeout(45_000),
    })
  } catch {
    return NextResponse.json({ error: 'Помощник не ответил — попробуйте ещё раз' }, { status: 504 })
  }
  const data = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  } | null
  const answer = data?.choices?.[0]?.message?.content?.trim()
  if (!response.ok || !answer) {
    console.error('guide-ask failed', response.status)
    return NextResponse.json({ error: 'Помощник не смог ответить — попробуйте ещё раз' }, { status: 502 })
  }
  recordUsage({
    provider: 'deepseek',
    model,
    inputTokens: data?.usage?.prompt_tokens ?? 0,
    outputTokens: data?.usage?.completion_tokens ?? 0,
    metadata: { feature: 'guide-ask' },
  })
  return NextResponse.json({ answer })
}
