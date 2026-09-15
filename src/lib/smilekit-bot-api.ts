// Клиент внутреннего HTTP-слоя Telegram-бота Smilekit (aiogram, Railway-сервис
// smilekit-bot). Бот — источник истины по промптам/модели: CRM только читает
// и пишет /internal/* через общий секрет.
//
// ВАЖНО: только для серверного кода (Server Components, Server Actions, Route
// Handlers). SMILEKIT_BOT_INTERNAL_TOKEN не имеет префикса NEXT_PUBLIC_ и не
// должен попадать в браузер — поэтому здесь нет 'use client' и файл не
// импортируется из клиентских компонентов.

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Сколько ждать генерацию ответа (/internal/lab). ОБЯЗАНО быть больше
 * внутреннего лимита самого бота (bot/smilekit_bot/service.py):
 * роутер 8с + черновик 20с + ревью 15с ≈ 43с.
 *
 * Живой инцидент: /internal/lab шёл с общими 15с. Каждый медленный ответ
 * нейросети кончался тем, что CRM бросала запрос, повторяла его (запуская у
 * бота вторую генерацию поверх первой) и слала клиенту заглушку «не
 * расслышала». Проверка чеков и транскрибация уже шли со своими длинными
 * таймаутами (45с и 75с прямо в вызовах) — у них этой ошибки не было.
 */
export const BOT_TIMEOUTS_MS = {
  lab: 50_000,
} as const

export interface SmilekitBotApiFailure {
  ok: false
  error: string
  status: number
}

export type SmilekitBotApiResult<T> = { ok: true; data: T } | SmilekitBotApiFailure

function baseUrl(): string | null {
  return process.env.SMILEKIT_BOT_API_URL?.replace(/\/$/, '') || null
}

/** Настроена ли интеграция — страницы показывают подсказку вместо пустого экрана. */
export function isSmilekitBotConfigured(): boolean {
  return Boolean(baseUrl() && process.env.SMILEKIT_BOT_INTERNAL_TOKEN)
}

/**
 * Запрос к /internal/* бота с общим секретом.
 * Ошибки бота (400/403) возвращаются как значение, а не бросаются — так
 * действия могут показать причину пользователю, а не общий "что-то пошло не так".
 */
export async function smilekitBotFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<SmilekitBotApiResult<T>> {
  const base = baseUrl()
  const token = process.env.SMILEKIT_BOT_INTERNAL_TOKEN
  if (!base || !token) {
    return {
      ok: false,
      status: 503,
      error: 'Интеграция с ботом не настроена: задайте SMILEKIT_BOT_API_URL и SMILEKIT_BOT_INTERNAL_TOKEN',
    }
  }

  const headers: Record<string, string> = { 'x-internal-token': token }
  let body: BodyInit | undefined
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.body)
  }

  let response: Response
  try {
    response = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (error) {
    // Раньше ЛЮБАЯ ошибка превращалась в «Бот недоступен». Но чаще всего бот
    // жив и работает — просто не уложился в наш таймаут. Разные причины
    // требуют разной реакции (таймаут бессмысленно повторять — это удвоит
    // нагрузку на ту же медленную нейросеть), поэтому различаем их.
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: false, status: 504, error: 'Бот не успел ответить за отведённое время' }
    }
    return { ok: false, status: 502, error: 'Бот недоступен — проверьте, что smilekit-bot запущен' }
  }

  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const record = (payload ?? {}) as { error?: unknown }
    const error =
      (typeof record.error === 'string' && record.error) || `Ошибка бота (${response.status})`
    return { ok: false, status: response.status, error }
  }

  return { ok: true, data: (payload ?? {}) as T }
}
