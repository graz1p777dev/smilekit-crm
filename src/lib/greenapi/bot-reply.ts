// ИИ-ответ клиенту в WhatsApp через Green API — замена amoCRM/WhatCRM-канала
// (src/lib/amocrm/bot-reply.ts) на тот же номер, но без amoCRM в цепочке.
//
// Тот же мозг (тот же Telegram-бот Smilekit, /internal/lab), тот же скрипт
// продаж и тот же принцип «наш сервер — мастер истории» — меняется только
// транспорт (Green API вместо amojo) и адресация: chat_id здесь — номер
// телефона, а не внутренний chat_id amoCRM.
//
// История лежит в общей amocrm_messages (таблица канало-независимая по
// набору колонок), id сообщений Green API префиксуются `ga:` — так оба
// канала живут рядом без отдельной таблицы и миграции.
//
// В отличие от amoCRM-канала: Green API отдаёт голосовое сразу с прямой
// ссылкой в вебхуке — не нужен retry-поиск в «истории чата», её просто нет
// как отдельного API.

import { createAdminClient } from '@/lib/supabase/admin'
import { smilekitBotFetch } from '@/lib/smilekit-bot-api'
import { upsertDealFromInbound } from '@/lib/deals/auto-create'
import { advanceDealFromBotAction } from '@/lib/deals/advance-stage'
import { ingestOrder } from '@/lib/orders/ingest'
import { decrementStock, getWhatsappBotConfig } from '@/lib/greenapi/config'
import {
  DEFAULT_COMPLAINT_PROMPT,
  DEFAULT_COOPERATION_REPLY,
  DEFAULT_DOUBT_RESULT_REPLY,
  DEFAULT_FIRST_USE_EFFECT,
  DEFAULT_LOW_STOCK_CTA,
  DEFAULT_ORDER_CHECKLIST,
  DEFAULT_PRODUCT_INFO,
  DEFAULT_SAFETY_COMPOSITION,
} from '@/lib/greenapi/default-templates'
import {
  sendGreenApiDeliveryGroupFile,
  sendGreenApiFileByUrl,
  sendGreenApiMessage,
  sendGreenApiVoice,
} from '@/lib/greenapi/client'
import { createLimiter } from '@/lib/concurrency-limit'

export interface InboundGreenApiMessage {
  providerMessageId: string
  chatId: string // нормализованный телефон (только цифры), см. phoneFromGreenApiChatId
  authorName: string | null
  text: string
  messageType?: string
  mediaUrl?: string | null
}

const VOICE_TYPES = new Set(['voice', 'audio', 'audioMessage'])
const IMAGE_TYPES = new Set(['image', 'imageMessage', 'documentMessage'])
const MAX_VOICE_BYTES = 20 * 1024 * 1024
const MAX_RECEIPT_BYTES = 20 * 1024 * 1024

interface ReceiptCheck {
  is_real_receipt_screenshot: boolean
  amount_ok: boolean
  recipient_ok: boolean
  date_ok: boolean
}

/**
 * Клиент прислал картинку — почти всегда это чек об оплате. Проверяем теми же
 * критериями, что и Telegram-бот (assistant.verify_receipt): формат, сумма,
 * получатель, дата. Раньше картинки не обрабатывались вовсе: бот видел только
 * подпись к фото и предлагал предоплату уже оплатившему клиенту.
 */
async function verifyGreenApiReceipt(mediaUrl: string, referenceDate: string): Promise<ReceiptCheck | null> {
  const response = await fetch(mediaUrl, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`greenapi receipt download: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length || bytes.length > MAX_RECEIPT_BYTES) throw new Error('greenapi receipt: invalid size')
  const mime = response.headers.get('content-type') ?? 'image/jpeg'
  const isPdf = mime.includes('pdf')
  const result = await smilekitBotFetch<ReceiptCheck>('/internal/verify_receipt', {
    method: 'POST',
    body: { imageBase64: bytes.toString('base64'), today: referenceDate, kind: isPdf ? 'pdf' : 'image', mime },
  })
  return result.ok ? result.data : null
}

/**
 * Дата, с которой сверяется чек. Это день отправки QR, а не «сегодня»: клиент
 * получает QR вечером и платит после полуночи — по «сегодня» такой чек
 * считался бы вчерашним и отклонялся. Если QR в истории нет — сегодняшний день.
 */
async function receiptReferenceDate(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string
): Promise<string> {
  const bishkekDate = (value: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bishkek' }).format(value)
  const { data } = await supabase
    .from('amocrm_messages')
    .select('created_at')
    .eq('chat_id', chatId)
    .eq('text', '[QR оплаты]')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const sentAt = (data as { created_at?: string } | null)?.created_at
  return bishkekDate(sentAt ? new Date(sentAt) : new Date())
}

const RECEIPT_ACCEPTED =
  'Спасибо, чек получила! ✅ Заказ оформлен — передаю в доставку.\n\n' +
  'Курьер свяжется с вами перед выездом.'

const RECEIPT_REJECTED =
  'Спасибо! Чек ушёл на проверку менеджеру — он свяжется с вами в ближайшее время. 😊'

async function transcribeGreenApiVoice(input: InboundGreenApiMessage): Promise<string | null> {
  if (!VOICE_TYPES.has(input.messageType ?? '') || !input.mediaUrl) return input.text
  const response = await fetch(input.mediaUrl, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`greenapi voice download: HTTP ${response.status}`)
  const size = Number(response.headers.get('content-length') || 0)
  if (size > MAX_VOICE_BYTES) throw new Error('greenapi voice download: file is too large')
  const audio = Buffer.from(await response.arrayBuffer())
  if (!audio.length || audio.length > MAX_VOICE_BYTES) throw new Error('greenapi voice download: invalid size')
  const extension = new URL(input.mediaUrl).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? 'ogg'
  const result = await smilekitBotFetch<{ transcript: string }>('/internal/transcribe', {
    method: 'POST',
    body: { audioBase64: audio.toString('base64'), filename: `voice.${extension}` },
  })
  return result.ok ? result.data.transcript.trim() || null : null
}

// ─── Скрипт продаж — те же тексты и правила, что в amoCRM-канале
// (src/lib/amocrm/bot-reply.ts), держим синхронно вручную до объединения
// в общий модуль (см. задачу «обобщить bot-reply.ts под мульти-провайдера»).

const PRODUCT_INFO = DEFAULT_PRODUCT_INFO

const KYRGYZ_PRODUCT_INFO =
  'Салам! 😊 Бир кутусу — 1490 сом. Ичинде 14 даана тилке бар — бул толук курс. ' +
  'Таасири биринчи колдонуудан кийин эле байкалат.\n\n' +
  'Кайсы шаардан болосуз? Жеткирүү боюнча айтып берем.'

const KYRGYZ_MARKERS =
  /баа|наркы|канча|кайсы|шаар|жеткир|тиш|агарт|колдон|куту|барбы|алам|керек|рахмат|болобу|кантип|эмне/i
const KYRGYZ_PRICE_INTENT = /баа|наркы|канча\s*(?:сом|турат)/i
const LINK_IN_MESSAGE = /(?:https?:\/\/|www\.)\S+/i
const GREETING_ONLY = /^\s*(?:улыбка|здравствуйте|здравствуй|привет|добрый\s+(?:день|вечер|утро))[!,.?\s😊👋]*$/iu

const CITY_QUESTION = 'Подскажите, пожалуйста, из какого вы города?'

const FIRST_USE_EFFECT = DEFAULT_FIRST_USE_EFFECT

const LOW_STOCK_DISCOUNT_CTA = DEFAULT_LOW_STOCK_CTA

const ORDER_CHECKLIST = DEFAULT_ORDER_CHECKLIST

const RETURNING_GREETING_REPLIES = [
  'Здравствуйте! 😊 Рада снова вас видеть. Чем могу помочь?',
  'Здравствуйте! 😊 Конечно, я на связи. Что подсказать?',
  'Здравствуйте! 😊 Продолжим — чем могу помочь?',
]

const RETURNING_KYRGYZ_GREETING_REPLIES = [
  'Салам! 😊 Кайрадан көргөнүмө кубанычтамын. Кантип жардам берейин?',
  'Салам! 😊 Мен байланышта элем. Эмне боюнча жардам керек?',
]

const COMPLAINT_PROMPT = DEFAULT_COMPLAINT_PROMPT

const COOPERATION_REPLY = DEFAULT_COOPERATION_REPLY

// Регионы Кыргызстана/Казахстана вне Бишкека/Токмока едут одной и той же
// «Ылдам Экспресс» — этот же текст служит и явным совпадением по городу,
// и запасным вариантом для сёл/малых населённых пунктов, которых нет и не
// может быть в списке regex (см. REGIONAL_DELIVERY_FALLBACK ниже): раньше
// такие случаи (например, «Село.Арчалы») уходили в ИИ, который сам выдумывал
// сроки и стоимость доставки — теперь только заранее утверждённый текст.
const REGIONAL_DELIVERY_TEMPLATE = 'Да, у нас есть доставка через Ылдам Экспресс 🚚✅ За 1 день доставим прям до дома.'

const DELIVERY_TEMPLATES: [RegExp, string][] = [
  [/бишкек|токмок/, 'Отлично, у нас есть доставка через Яндекс, за 30 минут доставим'],
  [/\bош\b|джалал-?абад|каракол|нарын|талас|баткен|балыкч|манас/, REGIONAL_DELIVERY_TEMPLATE],
  [/алмат/, 'Да, доставим! В Алматы — ориентировочно в течение 30 минут'],
  [/астан/, 'Да, доставим! По остальным регионам Казахстана — ориентировочно за 1–3 дня'],
  [/ташкент/, 'Да, доставим! В Ташкенте — ориентировочно в течение 1 часа'],
  [
    /москв|росси/,
    'Своего склада в России нет, отправляем через СДЭК — доставка от 7 дней. Точную стоимость доставки уточним отдельно',
  ],
]

function deliveryTemplateForCity(text: string): string | null {
  const normalized = text.toLowerCase()
  for (const [pattern, template] of DELIVERY_TEMPLATES) {
    if (pattern.test(normalized)) return template
  }
  return null
}

function shouldSendResultsAfterLocation(text: string, historyText: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ')
  const priorPrice = historyText.includes('цена') || historyText.includes('сом')
  if (!priorPrice || LINK_IN_MESSAGE.test(text) || GREETING_ONLY.test(text)) return false
  const askedForCity = historyText.includes('из какого вы города') || historyText.includes('вы в бишкеке')
  const shortLocationAnswer = !/[?？]/.test(text) && normalized.split(/\s+/).length <= 5
  const deliveryQuestion = /достав|жеткир|отправ|привез/iu.test(text)
  return deliveryQuestion || (askedForCity && shortLocationAnswer)
}

const ORDER_INTENT =
  /хочу\s+(?:заказать|купить|взять)|(?:как|где)\s+(?:заказать|купить|оформить)|закажу|заказать|оформить|оформляйте|оформляем|\bберу\b|возьму|можно\s+оформить|реквизит|куда\s+(?:скинуть|перевести|оплатить|платить)|как\s+оплатить|способ\s+оплаты|\bqr[\s-]?код/i

// Короткое согласие само по себе намерения не выражает («давайте» может
// относиться к чему угодно) — засчитываем его как заказ, только если прошлое
// сообщение бота было предложением оформить. Иначе ответ уходил в ИИ и клиент
// вместо чек-листа получал произвольную формулировку.
const AFFIRMATIVE_ONLY =
  /^\s*(?:да|ага|угу|давай(?:те)?|ок(?:ей)?|хорошо|конечно|согласен|согласна|можно)[\s!.,)😊👍]*$/i
// Ответ «нет» на follow-up ORDER_CTA_FOLLOWUP_TEXT — единственный триггер
// скидки 13%: до follow-up скидку не предлагаем вовсе.
const NEGATIVE_ONLY = /^\s*(?:нет|неа|не\s+хочу|не\s+буду|не\s+надо|откажусь|подумаю)[\s!.,)😔👎]*$/i
// ИИ формулирует призыв по-разному: «Оформить вам?», «Вам оформить доставку?»,
// «Оформить?» — привязка к точному порядку слов не работала, и согласие
// клиента уходило в ИИ вместо чек-листа.
const ORDER_CTA_MARKER = /оформ\w*[^.!?]*\?/i

// Подводка перед фото — дословно как в Telegram (__main__.py).
const RESULTS_INTRO = 'Вот результат нашего клиента до и после применения 👇'

// После блока результата скидку больше не предлагаем сразу — только вопрос
// «вам оформить?» через 5 минут молчания (followup-scheduler.ts), а скидка —
// только если клиент на этот вопрос ответил отказом (NEGATIVE_ONLY ниже).
export const ORDER_CTA_FOLLOWUP_TEXT = 'Вам оформить? Пока есть в наличии.'
// Маркер-якорь для followup-scheduler.ts: последняя запись в чате с этим
// текстом и sender='bot' — сигнал «ждём 5 минут тишины клиента». Как только
// появляется любое следующее сообщение (клиент ответил или сам follow-up
// ушёл), якорь перестаёт быть последней записью и больше не триггерит.
export const FOLLOWUP_ANCHOR_TEXT = '[ожидание оформления]'

// Дожим через 24 часа, если клиент не ответил и на вопрос из
// ORDER_CTA_FOLLOWUP_TEXT (followup-scheduler.ts проверяет оба порога:
// 5 минут для вопроса, 24 часа для дожима). Тот же принцип «последняя
// запись в чате» — ответ клиента или уже отправленный дожим снимает триггер.
export const NUDGE_24H_TEXT = 'Ещё актуально? 😊 Обычно долго не бронируем — оформляем, пока есть в наличии?'

// Тот же набор, что уходит альбомом в Telegram (media.result_photo_group).
// WhatsApp альбомов не поддерживает — шлём по одному; подписи «До»/«После»
// нужны, потому что без album-группировки порядок иначе не читается.
const RESULT_PHOTOS: readonly (readonly [string, string])[] = [
  ['before_after.jpg', ''],
]

const DOUBT_RESULT_REPLY = DEFAULT_DOUBT_RESULT_REPLY

const SCAM_DOUBT =
  /(?:вы\s+)?(?:точно\s+)?не\s+мошенник|мошенники\s*\?|(?:это\s+)?(?:точно\s+)?не\s+(?:обман|развод|скам|фейк)|без\s+обмана|(?:это\s+)?(?:все|всё)?\s*реально\s*(?:да|\?)|не\s+кин[её]те|вам\s+можно\s+доверять|можно\s+(?:ли\s+)?вам\s+верить|вы\s+настоящие/i

// Тот же роутер-сценарий "safety_composition", что в Telegram-боте
// (service.py ROUTE_TOOL): вопрос про состав/безопасность/вред для эмали
// или дёсен. Раньше в WhatsApp такой ветки не было вовсе — вопрос уходил в
// ИИ, который сочинял свой ответ вместо утверждённого текста.
const SAFETY_COMPOSITION_DOUBT =
  /вред(?:ит|но|ен)?[^.!?]{0,15}(?:эмал|дёсн|десн)|(?:эмал|дёсн|десн)[^.!?]{0,15}вред|опасн\w*[^.!?]{0,15}(?:эмал|дёсн|десн|состав)|(?:безопасн\w*[^.!?]{0,15}состав|состав[^.!?]{0,15}безопасн)/i

const COMPLAINT =
  /развод|обман(?:ули)?|кинул|мошенник|верните\s+деньги|хочу\s+возврат|ужасн(?:о|ый|ая)|отвратительн|никогда\s+(?:больше\s+)?не\s+куплю|не\s+помогл|разочарован/i
const COOPERATION =
  /сотрудничеств|оптом|\bопт\b|дистрибьютор|дилер|партн[её]р|реселлер|перепродаж|b2b|блогер/i

const READY_TO_BUY = /оформ(?:ить|ляйте)|заказ(?:ать|ываю)?|беру\b|покупаю\b|заброниру|резервиру/i
const INTEREST_CONFIRMED = /хочу\b|подходит|устраивает|интересует|готов\s+(?:взять|купить)|давайте/i
const NEED_IDENTIFIED =
  /полоск|отбелив|улыбк|зуб|цена|сколько\s+стоит|состав|инструкц|противопоказ|результат|скидк|доставк|коробк/i

function stageActionForInbound(text: string): string | null {
  const value = text.replace(/ё/g, 'е')
  if (READY_TO_BUY.test(value)) return 'ready_to_buy'
  if (INTEREST_CONFIRMED.test(value)) return 'interest_confirmed'
  if (NEED_IDENTIFIED.test(value)) return 'need_identified'
  return null
}

/** Исходящее сообщение из вебхука (outgoingMessageReceived/outgoingAPIMessageReceived
 * с чужим providerMessageId) — живой менеджер написал в WhatsApp напрямую. */
export async function registerOutgoingGreenApiMessage(input: InboundGreenApiMessage): Promise<void> {
  const supabase = createAdminClient()
  // Окно эха расширено с 5 минут до суток: под нагрузкой (см. AmoBotToggle,
  // getDealConversation — тот же класс зависаний сервера) собственная
  // отправка бота иногда фактически уходит клиенту с большой задержкой —
  // на живых данных зафиксирован разрыв 21+ минуту между сообщением клиента
  // и приходом эха. Опоздавшее эхо не находило себе пару в 5-минутном окне
  // и записывалось как сообщение живого менеджера — бот замолкал в этом
  // чате НАВСЕГДА (isManagerControllingChat), хотя ответил он сам. Точное
  // совпадение текста практически исключает случайное совпадение с реальным
  // сообщением человека.
  const { data: recentBot } = await supabase
    .from('amocrm_messages')
    .select('id')
    .eq('chat_id', input.chatId)
    .eq('sender', 'bot')
    .eq('text', input.text)
    .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
    .limit(1)
  if (recentBot?.length) return // эхо нашей же отправки

  await supabase.from('amocrm_messages').upsert(
    {
      amo_message_id: `ga:${input.providerMessageId}`,
      chat_id: input.chatId,
      direction: 'out',
      sender: 'operator',
      author_name: input.authorName,
      text: input.text,
    },
    { onConflict: 'amo_message_id', ignoreDuplicates: true }
  )
}

const chatQueues = new Map<string, Promise<void>>()
const globalGreenApiProcessingLimit = createLimiter(4)

async function isManagerControllingChat(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string
): Promise<boolean> {
  const [lastOperatorResult, controlResult] = await Promise.all([
    supabase
      .from('amocrm_messages')
      .select('created_at')
      .eq('chat_id', chatId)
      .eq('sender', 'operator')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('amocrm_chat_control')
      .select('bot_enabled, updated_at')
      .eq('chat_id', chatId)
      .maybeSingle(),
  ])
  const lastOperatorAt = lastOperatorResult.data?.created_at
    ? new Date(lastOperatorResult.data.created_at as string).getTime()
    : null
  const control = controlResult.data as { bot_enabled: boolean; updated_at: string } | null
  if (!control) return lastOperatorAt !== null
  const overrideIsFresh = lastOperatorAt === null || new Date(control.updated_at).getTime() > lastOperatorAt
  if (overrideIsFresh) return !control.bot_enabled
  return true
}

async function isPhoneBlockedForBot(
  supabase: ReturnType<typeof createAdminClient>,
  rawPhone: string | null
): Promise<boolean> {
  const phone = String(rawPhone || '').replace(/\D/g, '')
  if (!phone) return false
  const { data } = await supabase
    .from('campaign_opt_outs')
    .select('phone')
    .eq('phone', phone)
    .eq('block_bot_replies', true)
    .maybeSingle()
  return Boolean(data)
}

/**
 * Разрешает блок «после города» (доставка, фото, голосовое, CTA) ровно один
 * раз за чат — порт storage.claim_event из Telegram-бота. Маркер живёт в той
 * же таблице истории: UNIQUE(amo_message_id) делает захват атомарным,
 * повторный вызов ничего не вставит и вернёт false.
 */
async function claimResultsBlock(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('amocrm_messages')
    .upsert(
      {
        amo_message_id: `ga:claim:results:${chatId}`,
        chat_id: chatId,
        direction: 'out',
        sender: 'bot',
        text: '[фото до/после]',
      },
      { onConflict: 'amo_message_id', ignoreDuplicates: true }
    )
    .select('id')
  if (error) {
    console.error('greenapi bot-reply: results claim failed', error.message)
    return false
  }
  return Boolean(data?.length)
}

/**
 * Обкатка на своих номерах: пока GREENAPI_ALLOWED_PHONES не пуст, бот
 * отвечает только перечисленным номерам (через запятую, только цифры).
 * Остальным клиентам история и сделки ведутся как обычно, но ответов нет.
 * Пустая переменная — обычный режим, отвечаем всем.
 */
function isPhoneAllowedForBot(chatId: string): boolean {
  const allowed = (process.env.GREENAPI_ALLOWED_PHONES ?? '')
    .split(',')
    .map((value) => value.replace(/\D/g, ''))
    .filter(Boolean)
  return allowed.length === 0 || allowed.includes(chatId.replace(/\D/g, ''))
}

/**
 * skipIntegrationCheck — только для локальной «Лаборатории» (см.
 * src/app/api/greenapi-lab/route.ts): даёт погонять ровно ту же логику
 * бота на тестовом chat_id, не включая реальный аварийный выключатель
 * (integrations.amoCRM), который молчит для настоящих клиентов.
 * dryRun — не дёргать реальный Green API (тестовый chat_id всё равно не
 * существует в WhatsApp), ответы читаются из уже записанных строк в БД.
 */
export interface GreenApiTestOptions {
  skipIntegrationCheck?: boolean
  dryRun?: boolean
}

export async function canSendGreenApiBotReply(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string,
  opts: GreenApiTestOptions = {}
): Promise<boolean> {
  if (!isPhoneAllowedForBot(chatId)) return false
  // Общий с amoCRM-каналом аварийный выключатель (integrations.amoCRM) —
  // это переключатель «бот продаж SmileKit включён», а не именно amoCRM.
  const [integrationResult, managerControls] = await Promise.all([
    supabase.from('integrations').select('is_active').eq('name', 'amoCRM').maybeSingle(),
    isManagerControllingChat(supabase, chatId),
  ])
  if (integrationResult.error) return false
  const integrationActive = opts.skipIntegrationCheck
    ? true
    : Boolean((integrationResult.data as { is_active?: boolean } | null)?.is_active)
  return integrationActive && !managerControls
}

function enqueueInboundGreenApiMessage(
  input: InboundGreenApiMessage,
  opts: GreenApiTestOptions
): Promise<void> {
  const prev = chatQueues.get(input.chatId) ?? Promise.resolve()
  const run = prev.then(() => globalGreenApiProcessingLimit(() => processInboundGreenApiMessageNow(input, opts)))
  const chain = run.then(() => {}, () => {})
  chatQueues.set(input.chatId, chain)
  chain.then(() => {
    if (chatQueues.get(input.chatId) === chain) chatQueues.delete(input.chatId)
  })
  return run
}

export function processInboundGreenApiMessage(
  input: InboundGreenApiMessage,
  opts: GreenApiTestOptions = {}
): Promise<void> {
  return enqueueInboundGreenApiMessage(input, opts)
}

/**
 * Чек от клиента: проверить → ответить → отправить заказ в группу доставки
 * Telegram (тот же чат, куда падают заказы из Telegram-бота). Чек, не прошедший
 * проверку, всё равно уходит в группу — с пометкой для ручной проверки, чтобы
 * менеджер увидел его, а не потерял.
 */
async function handleGreenApiReceipt(
  supabase: ReturnType<typeof createAdminClient>,
  input: InboundGreenApiMessage,
  externalKey: string
): Promise<void> {
  let check: ReceiptCheck | null = null
  try {
    check = await verifyGreenApiReceipt(input.mediaUrl!, await receiptReferenceDate(supabase, input.chatId))
  } catch (error) {
    console.error('greenapi bot-reply: receipt verification failed', error)
  }
  // Проверка не отработала (нет ответа или все критерии false — так падает
  // verify_receipt при сбое) — это не «чек плохой», а «мы не смогли
  // проверить». Разница важна: иначе менеджер видит в группе четыре ложные
  // причины несовпадения на идеальном чеке.
  const checkUnavailable =
    !check || !(check.is_real_receipt_screenshot || check.amount_ok || check.recipient_ok || check.date_ok)
  const verified = Boolean(
    check?.is_real_receipt_screenshot && check.amount_ok && check.recipient_ok && check.date_ok
  )
  const reply = verified ? RECEIPT_ACCEPTED : RECEIPT_REJECTED

  if (!(await canSendGreenApiBotReply(supabase, input.chatId))) return
  const botMessageId = `ga:bot:${input.providerMessageId}:receipt`
  await supabase.from('amocrm_messages').upsert({
    amo_message_id: botMessageId,
    chat_id: input.chatId,
    direction: 'out',
    sender: 'bot',
    text: reply,
  }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
  try {
    await sendGreenApiMessage(`${input.chatId}@c.us`, reply)
  } catch (error) {
    await supabase.from('amocrm_messages').delete().eq('amo_message_id', botMessageId)
    console.error('greenapi bot-reply: receipt reply failed', error)
    return
  }

  // Адрес клиент обычно пишет подписью к чеку или соседним сообщением —
  // берём последние свои сообщения, чтобы менеджеру в группе не пришлось
  // лезть в переписку.
  const { data: recent } = await supabase
    .from('amocrm_messages')
    .select('text, sender')
    .eq('chat_id', input.chatId)
    .eq('sender', 'client')
    .order('created_at', { ascending: false })
    .limit(5)
  const clientNotes = (recent ?? []).map((row) => (row as { text: string }).text).filter(Boolean).join(' | ')

  // Заказ в CRM — страница «Заказы» и карточка сделки должны видеть чек и
  // адрес, а не только Telegram-группу доставки. Ссылка на чек — тем же
  // маркером, что и в переписке (см. MEDIA_MARKER в src/actions/deals.ts).
  const { data: dealRow } = await supabase.from('deals').select('id').eq('external_key', externalKey).maybeSingle()
  await ingestOrder({
    externalKey: `${externalKey}:order:${input.providerMessageId}`,
    source: 'manual',
    customerName: input.authorName,
    customerPhone: input.chatId,
    quantity: 1,
    totalAmount: null,
    currency: 'KGS',
    summary:
      `${verified ? 'Чек проверен' : checkUnavailable ? 'Чек не проверен автоматически' : 'Чек не прошёл проверку'} (WhatsApp)` +
      (input.text ? `\nАдрес: ${input.text}` : '') +
      `\n[media]${input.mediaUrl}`,
  }).then((result) => {
    if (result.error) console.error('greenapi bot-reply: order ingest failed', result.error)
  })
  if ((dealRow as { id?: string } | null)?.id) {
    // ingestOrder не знает про deal_id — привязываем отдельно.
    const { data: orderRow } = await supabase
      .from('orders')
      .select('id')
      .eq('external_key', `${externalKey}:order:${input.providerMessageId}`)
      .maybeSingle()
    if ((orderRow as { id?: string } | null)?.id) {
      await supabase.from('orders').update({ deal_id: (dealRow as { id: string }).id }).eq('id', (orderRow as { id: string }).id)
    }
  }

  try {
    const bytes = await fetch(input.mediaUrl!, { signal: AbortSignal.timeout(20_000) })
      .then((response) => response.arrayBuffer())
    const pushed = await smilekitBotFetch('/internal/push_delivery', {
      method: 'POST',
      body: {
        imageBase64: Buffer.from(bytes).toString('base64'),
        kind: 'image',
        source: 'WhatsApp',
        customerName: input.authorName ?? null,
        customerPhone: input.chatId,
        address: input.text || null,
        orderSummary: clientNotes.slice(0, 350),
        mismatchReasons: verified ? null : checkUnavailable
          ? ['автопроверка недоступна — проверьте чек глазами']
          : [
            !check?.is_real_receipt_screenshot ? 'не похоже на скриншот перевода' : null,
            check && !check.amount_ok ? 'сумма не совпадает' : null,
            check && !check.recipient_ok ? 'получатель не совпадает' : null,
            check && !check.date_ok ? 'дата не совпадает' : null,
          ].filter(Boolean),
      },
    })
    if (!pushed.ok) console.error('greenapi bot-reply: delivery push failed', pushed.error)
  } catch (error) {
    console.error('greenapi bot-reply: delivery push failed', error)
  }

  const botConfig = await getWhatsappBotConfig()
  if (botConfig.deliveryGroupId) {
    // Промпт из настроек — свободный текст, {name}/{phone}/{address} заменяются
    // значениями заказа. Без промпта — тот же формат, что уходит в Telegram.
    const caption = (botConfig.deliveryPrompt || 'Новый заказ ({name}, {phone})\nАдрес: {address}')
      .replaceAll('{name}', input.authorName || '—')
      .replaceAll('{phone}', input.chatId)
      .replaceAll('{address}', input.text || '—')
    try {
      await sendGreenApiDeliveryGroupFile(botConfig.deliveryGroupId, {
        urlFile: input.mediaUrl!,
        fileName: 'receipt.jpg',
        caption,
      })
    } catch (error) {
      console.error('greenapi bot-reply: whatsapp delivery group push failed', error)
    }
  }

  // Товароучёт: коробка отгружается только на подтверждённый чек — реакция
  // ставится в переписке вручную и её не видно через Green API (вебхуки
  // Green API не отдают события реакций, см. заметку в передаче), поэтому
  // триггером служит уже существующая проверка чека, а не лайк.
  if (verified) await decrementStock(1)

  for (const hook of botConfig.outboundWebhooks) {
    fetch(hook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'order.created',
        channel: 'whatsapp',
        verified,
        customerName: input.authorName,
        customerPhone: input.chatId,
        address: input.text || null,
        receiptUrl: input.mediaUrl,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error) => console.error(`greenapi bot-reply: outbound webhook ${hook.name} failed`, error))
  }

  const advanced = await advanceDealFromBotAction(externalKey, 'order')
  if (!advanced.ok && advanced.error) {
    console.error('greenapi bot-reply: stage advance failed', 'order', advanced.error)
  }
}

/**
 * У части клиентов уже есть старая сделка с amoCRM-эпохи (amocrm:<leadId>,
 * тот же номер) — до переезда WhatsApp-канала на Green API. Без этой проверки
 * такой клиент получал ВТОРУЮ, новую сделку (greenapi:<phone>) на каждое
 * первое сообщение после переезда: два external_key на одного человека,
 * split-история, деньги считаются дважды в отчётах. Найдено на живых
 * данных 2026-08-14: один такой дубль уже возник за сутки.
 */
async function resolveGreenApiExternalKey(
  supabase: ReturnType<typeof createAdminClient>,
  phone: string
): Promise<string> {
  const greenApiKey = `greenapi:${phone}`
  const { data: own } = await supabase.from('deals').select('id').eq('external_key', greenApiKey).maybeSingle()
  if (own) return greenApiKey // обычный случай — разговор уже был через Green API

  // Свежих сообщений через greenapi: нет — ищем старую сделку по номеру.
  // Точное совпадение через .eq не годится: customer_phone хранится в разных
  // форматах ('+996 502 223 421' vs '996502223421'), поэтому фильтруем по
  // последним 9 цифрам (локальный номер без кода страны) и сверяем в JS.
  const suffix = phone.slice(-9)
  if (suffix.length === 9) {
    const { data: candidates } = await supabase
      .from('deals')
      .select('external_key, customer_phone')
      .ilike('customer_phone', `%${suffix}`)
      .limit(10)
    const match = (candidates ?? []).find((row) => {
      const key = String((row as { external_key: string | null }).external_key || '')
      if (!key.startsWith('amocrm:')) return false
      const rowPhone = String((row as { customer_phone: string | null }).customer_phone || '').replace(/\D/g, '')
      return rowPhone.endsWith(phone) || phone.endsWith(rowPhone)
    })
    if (match) return String((match as { external_key: string }).external_key)
  }

  return greenApiKey
}

async function processInboundGreenApiMessageNow(
  input: InboundGreenApiMessage,
  opts: GreenApiTestOptions = {}
): Promise<void> {
  const supabase = createAdminClient()

  const transcript = await transcribeGreenApiVoice(input)
  if (VOICE_TYPES.has(input.messageType ?? '') && !transcript) {
    console.error('greenapi bot-reply: voice transcription failed', input.providerMessageId)
    return
  }
  if (transcript) input = { ...input, text: transcript }

  const { data: inserted, error: insertError } = await supabase
    .from('amocrm_messages')
    .upsert(
      {
        amo_message_id: `ga:${input.providerMessageId}`,
        chat_id: input.chatId,
        direction: 'in',
        sender: 'client',
        author_name: input.authorName,
        // Ссылка на вложение хранится маркером прямо в тексте: отдельной
        // колонки под медиа нет, а чек менеджеру в карточке сделки нужен
        // (см. MEDIA_MARKER в src/actions/deals.ts).
        text: input.mediaUrl ? `${input.text}\n[media]${input.mediaUrl}` : input.text,
      },
      { onConflict: 'amo_message_id', ignoreDuplicates: true }
    )
    .select('id')
  if (insertError) {
    console.error('greenapi bot-reply: insert failed', insertError.message)
    return
  }
  if (!inserted?.length) return // дубль вебхука — уже обработано

  const externalKey = await resolveGreenApiExternalKey(supabase, input.chatId)
  const { data: integration } = await supabase
    .from('integrations')
    .select('is_active')
    .eq('name', 'amoCRM')
    .maybeSingle()
  const botEnabled = opts.skipIntegrationCheck
    ? true
    : Boolean((integration as { is_active?: boolean } | null)?.is_active)

  // dryRun (Лаборатория) не должен плодить настоящие сделки в воронке —
  // тестовый chat_id не должен быть виден менеджерам как реальный лид.
  if (externalKey.startsWith('greenapi:') && !opts.dryRun) {
    await upsertDealFromInbound({
      externalKey,
      source: 'whatsapp',
      customerName: input.authorName,
      customerPhone: input.chatId,
    })
  }

  if (await isManagerControllingChat(supabase, input.chatId)) return
  if (await isPhoneBlockedForBot(supabase, input.chatId)) return

  // Картинка от клиента — это чек. Отдельная ветка до общего скрипта: ИИ
  // картинку не видит и, не зная об оплате, предлагал предоплату уже
  // оплатившему клиенту.
  if (botEnabled && IMAGE_TYPES.has(input.messageType ?? '') && input.mediaUrl) {
    await handleGreenApiReceipt(supabase, input, externalKey)
    return
  }

  const inboundAction = COMPLAINT.test(input.text) || COOPERATION.test(input.text)
    ? 'non_standard_request'
    : stageActionForInbound(input.text)
  if (inboundAction && !opts.dryRun) {
    const advanced = await advanceDealFromBotAction(externalKey, inboundAction)
    if (!advanced.ok && advanced.error) {
      console.error('greenapi bot-reply: stage advance failed', inboundAction, advanced.error)
    }
  }

  if (!botEnabled) return
  // Ранний выход до генерации ответа: иначе на каждое сообщение постороннего
  // клиента впустую тратился бы вызов ИИ, а отправку всё равно отсечёт
  // canSendGreenApiBotReply.
  if (!isPhoneAllowedForBot(input.chatId)) return

  const { data: rows } = await supabase
    .from('amocrm_messages')
    .select('sender, text, id')
    .eq('chat_id', input.chatId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(31)
  const history = (rows ?? [])
    .reverse()
    .slice(0, -1)
    .filter((row) => !LINK_IN_MESSAGE.test((row as { text: string }).text))
    .map((row) => ({
      role: (row as { sender: string }).sender === 'client' ? 'user' : 'assistant',
      content: (row as { text: string }).text,
    }))
  const historyText = history.map((item) => item.content.toLowerCase()).join(' ')
  const isKyrgyz = KYRGYZ_MARKERS.test(input.text)

  const replies: string[] = []
  // Голосовые — как в Telegram: озвучиваем те же две реплики заранее
  // записанными файлами (assets/voice в боте), текст остаётся тем же.
  const voiceReplies = new Set<string>()
  let sendPaymentQr = false
  let needsFollowupAnchor = false
  let stageAction: string | null = null
  const priceKnown = historyText.includes('цена') || historyText.includes('сом')
  const looksLikeLocationAnswer = shouldSendResultsAfterLocation(input.text, historyText)
  // Город не совпал ни с одним regex (село, малый нас. пункт) — но раз это
  // похоже на ответ про город/доставку, шлём заранее утверждённый
  // региональный шаблон, а не отдаём вопрос ИИ: тот сам выдумывал сроки и
  // стоимость доставки под конкретное название (см. живой пример «Арчалы»).
  const deliveryTemplate = deliveryTemplateForCity(input.text) ?? (looksLikeLocationAnswer ? REGIONAL_DELIVERY_TEMPLATE : null)

  // Блок «после города» (доставка + фото + голосовое + CTA) уходит ровно один
  // раз за чат — как claim_event в Telegram. Условия-триггеры остаются
  // верными и дальше по диалогу: название города всплывает в адресе, а любой
  // короткий ответ проходит shouldSendResultsAfterLocation. Без общей
  // защиты бот повторял голосовое «эффект с первого раза» уже во время
  // оформления заказа — не к месту.
  const wantsResultsBlock = looksLikeLocationAnswer || Boolean(deliveryTemplate && priceKnown)
  const resultsBlockAllowed = wantsResultsBlock ? await claimResultsBlock(supabase, input.chatId) : false

  const lastBotMessage = [...history].reverse().find((item) => item.role === 'assistant')?.content ?? ''
  const acceptedOrderCta = AFFIRMATIVE_ONLY.test(input.text) && ORDER_CTA_MARKER.test(lastBotMessage)

  // Тексты, редактируемые из CRM («Настройки бота» → «Шаблоны») — пустая
  // строка в настройках означает «не переопределено», используем дефолт.
  const botConfig = await getWhatsappBotConfig()
  const T = {
    productInfo: botConfig.templates.productInfo || PRODUCT_INFO,
    orderChecklist: botConfig.templates.orderChecklist || ORDER_CHECKLIST,
    doubtResult: botConfig.templates.doubtResult || DOUBT_RESULT_REPLY,
    firstUseEffect: botConfig.templates.firstUseEffect || FIRST_USE_EFFECT,
    lowStockCta: botConfig.templates.lowStockCta || LOW_STOCK_DISCOUNT_CTA,
    complaintPrompt: botConfig.templates.complaintPrompt || COMPLAINT_PROMPT,
    cooperationReply: botConfig.templates.cooperationReply || COOPERATION_REPLY,
  }

  // Свои правила из настроек CRM — проверяются раньше встроенного скрипта:
  // владелец может перекрыть штатное поведение своим условием, не трогая код.
  // Первое совпавшее enabled-правило побеждает; regex ломает диалог только
  // самому себе (invalid regex) — try/catch, а не падение всего ответа.
  let customRuleReply: string | null = null
  for (const rule of botConfig.customRules) {
    if (!rule.enabled || !rule.trigger.trim()) continue
    try {
      if (new RegExp(rule.trigger, 'i').test(input.text)) {
        customRuleReply = rule.reply
        break
      }
    } catch (error) {
      console.error('greenapi bot-reply: invalid custom rule regex', rule.id, error)
    }
  }

  if (customRuleReply) {
    replies.push(customRuleReply)
  } else if (history.length > 0 && GREETING_ONLY.test(input.text)) {
    replies.push(
      isKyrgyz
        ? RETURNING_KYRGYZ_GREETING_REPLIES[Math.floor(Math.random() * RETURNING_KYRGYZ_GREETING_REPLIES.length)]
        : RETURNING_GREETING_REPLIES[Math.floor(Math.random() * RETURNING_GREETING_REPLIES.length)]
    )
  } else if (LINK_IN_MESSAGE.test(input.text) || GREETING_ONLY.test(input.text)) {
    replies.push(T.productInfo, CITY_QUESTION)
  } else if (isKyrgyz && KYRGYZ_PRICE_INTENT.test(input.text)) {
    replies.push(KYRGYZ_PRODUCT_INFO)
  } else if (history.length === 0) {
    replies.push(T.productInfo, CITY_QUESTION)
  } else if (SCAM_DOUBT.test(input.text)) {
    replies.push(T.doubtResult)
    voiceReplies.add(T.doubtResult)
  } else if (SAFETY_COMPOSITION_DOUBT.test(input.text)) {
    replies.push(DEFAULT_SAFETY_COMPOSITION)
  } else if (COMPLAINT.test(input.text)) {
    replies.push(T.complaintPrompt)
  } else if (COOPERATION.test(input.text)) {
    replies.push(T.cooperationReply)
  } else if (NEGATIVE_ONLY.test(input.text) && lastBotMessage === ORDER_CTA_FOLLOWUP_TEXT) {
    // Клиент отказался оформлять на follow-up «вам оформить?» — только
    // здесь и появляется скидка 13%, сразу после результата её не шлём.
    replies.push(T.lowStockCta)
  } else if (ORDER_INTENT.test(input.text) || acceptedOrderCta) {
    // QR отправляется сразу вместе с чек-листом (ниже, sendPaymentQr) — раньше
    // WhatsApp не умел слать картинки, поэтому клиента отправляли к менеджеру
    // за реквизитами. Green API картинки шлёт, так что ждать «подтверждения»
    // перед выдачей реквизитов больше не нужно.
    replies.push(T.orderChecklist)
    sendPaymentQr = true
    stageAction = 'order'
  } else if (deliveryTemplate && priceKnown && resultsBlockAllowed) {
    replies.push(deliveryTemplate, T.firstUseEffect)
    voiceReplies.add(T.firstUseEffect)
    needsFollowupAnchor = true
  }

  if (replies.length === 0) {
    const labMessage = isKyrgyz
      ? `${input.text}\n\nЖоопту толугу менен кыргыз тилинде бер. Орусча сөздөрдү аралаштырба.`
      : input.text
    const lab = await smilekitBotFetch<{ reply: string }>('/internal/lab', {
      method: 'POST',
      body: { message: labMessage, history },
    })
    if (!lab.ok) {
      console.error('greenapi bot-reply: lab failed', lab.error)
      return
    }
    const reply = lab.data.reply?.trim()
    if (!reply) return
    replies.push(
      ...reply
        .split(/<NEXT_MESSAGE>/i)
        .map((part) => part.trim())
        .filter(Boolean)
    )
    if (replies.length === 0) return
  }

  const chatId = `${input.chatId}@c.us`
  const mediaBaseUrl = process.env.SMILEKIT_BOT_API_URL?.replace(/\/$/, '')

  for (let index = 0; index < replies.length; index++) {
    if (!(await canSendGreenApiBotReply(supabase, input.chatId, opts))) return
    const text = replies[index]
    const botMessageId = `bot:${input.providerMessageId}:${index}`
    const { error: reserveError } = await supabase.from('amocrm_messages').upsert({
      amo_message_id: `ga:${botMessageId}`,
      chat_id: input.chatId,
      direction: 'out',
      sender: 'bot',
      text,
    }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
    if (reserveError) {
      console.error('greenapi bot-reply: bot message reserve failed', reserveError.message)
      return
    }
    try {
      // Голосовое вместо текста — те же файлы, что шлёт Telegram-бот.
      // Green API рендерит голосовой «пузырь» только для .ogg/Opus, поэтому
      // при любой ошибке откатываемся на текст, чтобы клиент не остался без
      // ответа.
      const voiceName = text === T.firstUseEffect ? 'first_use_effect.ogg' : 'not_scam.ogg'
      if (opts.dryRun) {
        // Тестовый chat_id не существует в WhatsApp — реальный вызов Green
        // API только тратил бы время и падал. Запись в amocrm_messages выше
        // уже сделана, этого достаточно, чтобы «Лаборатория» увидела ответ.
      } else if (voiceReplies.has(text) && mediaBaseUrl) {
        try {
          await sendGreenApiVoice(chatId, `${mediaBaseUrl}/media/voice/${voiceName}`, voiceName)
        } catch (error) {
          console.error('greenapi bot-reply: voice send failed, using text', error)
          await sendGreenApiMessage(chatId, text)
        }
      } else {
        await sendGreenApiMessage(chatId, text)
      }
    } catch (error) {
      await supabase.from('amocrm_messages').delete().eq('amo_message_id', `ga:${botMessageId}`)
      console.error('greenapi bot-reply: send failed', error)
      return
    }
    // QR оплаты — сразу за чек-листом, до всего остального: клиент попросил
    // оформить и должен получить реквизиты в том же сообщении-связке, а не
    // после отдельного «подтверждения».
    if (sendPaymentQr && index === 0 && mediaBaseUrl) {
      const qrMessageId = `ga:bot:${input.providerMessageId}:qr`
      const { error: qrReserveError } = await supabase.from('amocrm_messages').upsert({
        amo_message_id: qrMessageId,
        chat_id: input.chatId,
        direction: 'out',
        sender: 'bot',
        text: '[QR оплаты]',
      }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
      if (!qrReserveError && !opts.dryRun) {
        try {
          await sendGreenApiFileByUrl({
            chatId,
            urlFile: `${mediaBaseUrl}/media/results/qrcode.jpeg`,
            fileName: 'qrcode.jpeg',
          })
        } catch (error) {
          await supabase.from('amocrm_messages').delete().eq('amo_message_id', qrMessageId)
          console.error('greenapi bot-reply: qr send failed', error)
        }
      }
    }
    // Фото результатов — сразу после первой реплики, как в Telegram
    // (__main__.py: подводка -> send_media_group -> голосовое -> CTA).
    // Ровно один раз за чат: shouldSendResultsAfterLocation срабатывает на
    // каждый короткий ответ клиента, и без этой защиты бот присылал фото
    // снова и снова. В Telegram ту же роль играет storage.claim_event.
    if (resultsBlockAllowed && index === 0 && mediaBaseUrl) {
      // Запись бота ДО отправки обязательна для любого исходящего: эхо из
      // вебхука Green API ищет свежую строку sender='bot' с тем же текстом,
      // и без неё подводка опозналась бы как сообщение менеджера — бот
      // замолкал в чате прямо посреди отправки фото.
      await supabase.from('amocrm_messages').upsert({
        amo_message_id: `ga:bot:${input.providerMessageId}:results-intro`,
        chat_id: input.chatId,
        direction: 'out',
        sender: 'bot',
        text: RESULTS_INTRO,
      }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
      if (!opts.dryRun) {
        await sendGreenApiMessage(chatId, RESULTS_INTRO).catch((error) =>
          console.error('greenapi bot-reply: results intro failed', error)
        )
      }
      for (const [name, caption] of RESULT_PHOTOS) {
        if (!(await canSendGreenApiBotReply(supabase, input.chatId, opts))) return
        const photoMessageId = `bot:${input.providerMessageId}:result:${name}`
        const { error: photoReserveError } = await supabase.from('amocrm_messages').upsert({
          amo_message_id: `ga:${photoMessageId}`,
          chat_id: input.chatId,
          direction: 'out',
          sender: 'bot',
          text: caption || '[фото результата]',
        }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
        if (photoReserveError) {
          console.error('greenapi bot-reply: result photo reserve failed', photoReserveError.message)
          continue
        }
        if (!opts.dryRun) {
          try {
            await sendGreenApiFileByUrl({
              chatId,
              urlFile: `${mediaBaseUrl}/media/results/${name}`,
              fileName: name,
              caption: caption || undefined,
            })
          } catch (error) {
            await supabase.from('amocrm_messages').delete().eq('amo_message_id', `ga:${photoMessageId}`)
            console.error('greenapi bot-reply: result photo send failed', error)
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 700))
      }
    }
    if (index < replies.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 900 + Math.random() * 500))
    }
  }

  if (needsFollowupAnchor) {
    // DB-only маркер (не отправляется клиенту) — followup-scheduler.ts раз в
    // минуту ищет чаты, где это последняя запись и прошло 5+ минут.
    await supabase.from('amocrm_messages').upsert({
      amo_message_id: `ga:claim:followup-anchor:${input.chatId}:${input.providerMessageId}`,
      chat_id: input.chatId,
      direction: 'out',
      sender: 'bot',
      text: FOLLOWUP_ANCHOR_TEXT,
    }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
  }

  if (stageAction && !opts.dryRun) {
    const result = await advanceDealFromBotAction(externalKey, stageAction)
    if (!result.ok && result.error) {
      console.error('greenapi bot-reply: stage advance failed', stageAction, result.error)
    }
  }
}
