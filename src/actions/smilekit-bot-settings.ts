'use server'

// Настройки и лаборатория Telegram-бота Smilekit: GET/PUT /internal/settings и
// POST /internal/lab на боте (aiogram, Railway-сервис smilekit-bot). Бот
// хранит промпты сам (SQLite bot_settings) — CRM ими только управляет, как
// mostovoy-bot-settings.ts управляет ботом Мостового. Общий секрет
// добавляется в smilekitBotFetch на сервере и в браузер не попадает.

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { BOT_TIMEOUTS_MS, smilekitBotFetch } from '@/lib/smilekit-bot-api'
import {
  SMILEKIT_BOT_PROMPT_LIMIT,
  type SmilekitBotEvent,
  type SmilekitBotSettings,
  type SmilekitBotSettingsInput,
  type SmilekitLabMessage,
} from '@/lib/models/smilekit-bot'

const PAGE = '/dashboard/settings'

export async function getBotSettings(): Promise<
  { ok: true; data: SmilekitBotSettings } | { ok: false; error: string }
> {
  const result = await smilekitBotFetch<SmilekitBotSettings>('/internal/settings')
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, data: { ...result.data, models: result.data.models ?? [] } }
}

// Бот сам режет промпты по лимиту — здесь ловим то же самое заранее, чтобы
// пользователь увидел причину, а не «сохранилось, но не то».
const SettingsSchema = z.object({
  managerPrompt: z.string().max(SMILEKIT_BOT_PROMPT_LIMIT, 'Промпт менеджера длиннее 12000 символов').optional(),
  supervisorPrompt: z
    .string()
    .max(SMILEKIT_BOT_PROMPT_LIMIT, 'Промпт супервизора длиннее 12000 символов')
    .optional(),
  model: z.string().trim().min(1, 'Выберите модель').optional(),
})

const FIELD_LABELS: Record<keyof SmilekitBotSettingsInput, string> = {
  managerPrompt: 'Промпт менеджера',
  supervisorPrompt: 'Промпт супервизора',
  model: 'Модель',
}

export type SaveBotSettingsResult =
  | {
      success: true
      /** Ответ PUT — это перечитанное состояние из SQLite бота, не эхо запроса. */
      data: SmilekitBotSettings
      /** Расхождения «отправили → сохранилось»: бот обрезает молча, мы говорим вслух. */
      warnings: string[]
    }
  | { success: false; error: string }

export async function saveBotSettings(
  input: Partial<SmilekitBotSettingsInput>
): Promise<SaveBotSettingsResult> {
  const parsed = SettingsSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Ошибка валидации' }
  }

  const result = await smilekitBotFetch<SmilekitBotSettings & { truncated: string[] }>('/internal/settings', {
    method: 'PUT',
    body: parsed.data,
  })
  if (!result.ok) return { success: false, error: result.error }

  const saved: SmilekitBotSettings = { ...result.data, models: result.data.models ?? [] }
  const warnings: string[] = []

  if (parsed.data.model !== undefined && saved.model !== parsed.data.model) {
    warnings.push(`Бот не принял модель «${parsed.data.model}» и оставил «${saved.model}»`)
  }
  for (const field of result.data.truncated ?? []) {
    const label = FIELD_LABELS[field as keyof SmilekitBotSettingsInput] ?? field
    warnings.push(`${label}: текст был длиннее 12000 символов — бот обрезал его при сохранении`)
  }

  revalidatePath(PAGE)
  return { success: true, data: saved, warnings }
}

export type RunBotLabResult =
  | { success: true; reply: string }
  | { success: false; error: string }

export async function runBotLab(
  message: string,
  history: SmilekitLabMessage[]
): Promise<RunBotLabResult> {
  const trimmed = message.trim()
  if (!trimmed) return { success: false, error: 'Введите сообщение' }

  const result = await smilekitBotFetch<{ reply: string }>('/internal/lab', {
    method: 'POST',
    body: { message: trimmed, history },
    timeoutMs: BOT_TIMEOUTS_MS.lab,
  })
  if (!result.ok) return { success: false, error: result.error }
  return { success: true, reply: result.data.reply }
}

export type GetBotEventsResult =
  | { success: true; events: SmilekitBotEvent[] }
  | { success: false; error: string }

/** Живой журнал бота — страница опрашивает это раз в несколько секунд,
 * передавая sinceId последнего уже показанного события. */
export async function getBotEvents(sinceId = 0): Promise<GetBotEventsResult> {
  const query = sinceId > 0 ? `?sinceId=${sinceId}&limit=200` : '?limit=200'
  const result = await smilekitBotFetch<{ events: SmilekitBotEvent[] }>(`/internal/events${query}`)
  if (!result.ok) return { success: false, error: result.error }
  return { success: true, events: result.data.events }
}
