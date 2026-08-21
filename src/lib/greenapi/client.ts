// Отправка/приём WhatsApp-сообщений через Green API (green-api.com).
//
// В отличие от amojo (src/lib/amocrm/chat.ts) — это официально
// задокументированный API, без реверс-инжиниринга. idInstance/apiTokenInstance
// идут частями пути, а не query/header. apiUrl и mediaUrl у Green API разные
// для разных инстансов (регион хоста назначается при создании инстанса) —
// поэтому берём их из настроек инстанса в консоли Green API, а не хардкодим
// домен (доки прямо предупреждают: "using a host not intended for the
// instance can break the integration").

const ID_INSTANCE = process.env.GREENAPI_ID_INSTANCE
const API_TOKEN_INSTANCE = process.env.GREENAPI_API_TOKEN_INSTANCE
const API_URL = process.env.GREENAPI_API_URL?.replace(/\/$/, '')
const MEDIA_URL = process.env.GREENAPI_MEDIA_URL?.replace(/\/$/, '')

function requireConfig(): { idInstance: string; apiTokenInstance: string; apiUrl: string } {
  if (!ID_INSTANCE || !API_TOKEN_INSTANCE || !API_URL) {
    throw new Error('GREENAPI_ID_INSTANCE / GREENAPI_API_TOKEN_INSTANCE / GREENAPI_API_URL не заданы')
  }
  return { idInstance: ID_INSTANCE, apiTokenInstance: API_TOKEN_INSTANCE, apiUrl: API_URL }
}

/** Нормализует номер (в любом формате) в chatId WhatsApp: только цифры + '@c.us'. */
export function toGreenApiChatId(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return `${digits}@c.us`
}

/** Обратное преобразование: chatId → голый номер (для deals.external_key). */
export function phoneFromGreenApiChatId(chatId: string): string {
  return chatId.replace(/@c\.us$/, '')
}

interface CallApiOptions {
  base?: 'api' | 'media'
  timeoutMs?: number
  /** Сколько раз повторить при сетевой ошибке/таймауте/5xx (не при 4xx). */
  retries?: number
}

async function callApi<T>(method: string, body?: Record<string, unknown>, opts: CallApiOptions = {}): Promise<T> {
  const { idInstance, apiTokenInstance, apiUrl } = requireConfig()
  const host = opts.base === 'media' ? (MEDIA_URL || apiUrl) : apiUrl
  const url = `${host}/waInstance${idInstance}/${method}/${apiTokenInstance}`
  const retries = opts.retries ?? 0
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < retries
    let res: Response
    try {
      res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      })
    } catch (error) {
      if (!canRetry) throw error // сеть/таймаут
      await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)))
      continue
    }
    if (res.ok) return res.json()
    const text = await res.text().catch(() => '')
    if (res.status >= 500 && canRetry) {
      await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)))
      continue
    }
    throw new Error(`green-api ${method}: HTTP ${res.status} ${text.slice(0, 300)}`)
  }
}

// Отправка файла по ссылке медленнее текста: Green API сначала скачивает
// файл с нашего сервера (бот на Railway после простоя отвечает не сразу), а
// потом грузит его в WhatsApp — по докам 1–20 с только на доставку. С общим
// таймаутом 20 с голосовое/QR/фото периодически не уходили вовсе
// («иногда не отправляет QR»). Даём файлам больше времени и один повтор.
const FILE_SEND_TIMEOUT_MS = 60_000
const FILE_SEND_RETRIES = 1

export async function getGreenApiState(): Promise<string> {
  const data = await callApi<{ stateInstance: string }>('getStateInstance')
  return data.stateInstance
}

export interface SetGreenApiWebhookInput {
  webhookUrl: string
  webhookUrlToken: string
}

/** Включает вебхук на входящие/исходящие сообщения и статусы доставки. */
export async function setGreenApiWebhook(input: SetGreenApiWebhookInput): Promise<void> {
  await callApi('setSettings', {
    webhookUrl: input.webhookUrl,
    webhookUrlToken: input.webhookUrlToken,
    incomingWebhook: 'yes',
    outgoingMessageWebhook: 'yes',
    outgoingAPIMessageWebhook: 'yes',
    outgoingWebhook: 'yes',
    stateWebhook: 'yes',
  })
}

/** Отправляет текстовое сообщение. chatId — из toGreenApiChatId(phone). */
export async function sendGreenApiMessage(chatId: string, message: string): Promise<{ idMessage: string }> {
  return callApi('sendMessage', { chatId, message })
}

export interface SendGreenApiFileInput {
  chatId: string
  urlFile: string
  fileName: string
  caption?: string
}

/** Отправляет файл (фото/документ) по ссылке. fileName обязателен, с расширением. */
export async function sendGreenApiFileByUrl(input: SendGreenApiFileInput): Promise<{ idMessage: string }> {
  return callApi('sendFileByUrl', { ...input }, { timeoutMs: FILE_SEND_TIMEOUT_MS, retries: FILE_SEND_RETRIES })
}

/**
 * Голосовое сообщение. Green API не документирует отдельный sendVoice —
 * голосовой "пузырь" (а не файл-вложение) в WhatsApp рендерится только для
 * настоящего OGG/Opus (неофициально подтверждено сообществом, не в доках
 * Green API). Вызывающий код обязан передать .ogg/Opus, иначе клиент
 * получит файл вместо голосового.
 */
export async function sendGreenApiVoice(chatId: string, urlFile: string, fileName = 'voice.ogg'): Promise<{ idMessage: string }> {
  return sendGreenApiFileByUrl({ chatId, urlFile, fileName })
}

/** chatId группы WhatsApp: тот же формат отправки, но суффикс @g.us. */
export function toGreenApiGroupChatId(groupId: string): string {
  return groupId.endsWith('@g.us') ? groupId : `${groupId}@g.us`
}

/**
 * Отправка в группу WhatsApp (например «Доставки»). groupId — id из настроек
 * CRM («Настройки бота» → «Группа доставки»); пока не выбран — функция
 * ничего не шлёт и возвращает false, чтобы включение было осознанным
 * действием, а не побочным эффектом присвоения переменной окружения.
 */
export async function sendGreenApiDeliveryGroup(groupId: string | null, text: string): Promise<boolean> {
  if (!groupId) return false
  await sendGreenApiMessage(toGreenApiGroupChatId(groupId), text)
  return true
}

/** То же для файла — чек/фото заказа в группу. */
export async function sendGreenApiDeliveryGroupFile(
  groupId: string | null,
  input: Omit<SendGreenApiFileInput, 'chatId'>
): Promise<boolean> {
  if (!groupId) return false
  await sendGreenApiFileByUrl({ ...input, chatId: toGreenApiGroupChatId(groupId) })
  return true
}

export interface GreenApiGroup {
  id: string
  name: string
}

/** Список групп WhatsApp этого номера — для выбора группы доставки в CRM. */
export async function listGreenApiGroups(): Promise<GreenApiGroup[]> {
  const contacts = await callApi<{ id: string; name?: string }[]>('getContacts')
  return contacts.filter((c) => c.id?.endsWith('@g.us')).map((c) => ({ id: c.id, name: c.name || c.id }))
}
