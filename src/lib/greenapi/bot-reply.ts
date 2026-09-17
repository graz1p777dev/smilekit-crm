// ИИ-ответ клиенту в WhatsApp через Green API — замена amoCRM/WhatCRM-канала
// (src/lib/amocrm/bot-reply.ts) на тот же номер, но без amoCRM в цепочке.
//
// Тот же мозг (тот же Telegram-бот Smilekit, /internal/lab), тот же скрипт
// продаж и тот же принцип «наш сервер — мастер истории» — меняется только
// транспорт (Green API вместо amojo) и адресация: chat_id здесь — номер
// телефона, а не внутренний chat_id amoCRM.
//
// История лежит в общей chat_messages (таблица канало-независимая по
// набору колонок), id сообщений Green API префиксуются `ga:` — так оба
// канала живут рядом без отдельной таблицы и миграции.
//
// В отличие от amoCRM-канала: Green API отдаёт голосовое сразу с прямой
// ссылкой в вебхуке — не нужен retry-поиск в «истории чата», её просто нет
// как отдельного API.

import { createAdminClient } from '@/lib/supabase/admin'
import { BOT_TIMEOUTS_MS, smilekitBotFetch } from '@/lib/smilekit-bot-api'
import { upsertDealFromInbound } from '@/lib/deals/auto-create'
import { advanceDealFromBotAction } from '@/lib/deals/advance-stage'
import { isIntegrationBotEnabled } from '@/lib/integration-status'
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
  sendGreenApiDeliveryGroup,
  sendGreenApiDeliveryGroupFile,
  sendGreenApiFileByUrl,
  sendGreenApiMessage,
  sendGreenApiVoice,
} from '@/lib/greenapi/client'
import { createLimiter } from '@/lib/concurrency-limit'
import { WHATSAPP_INTEGRATION_NAMES } from '@/lib/integration-names'

export interface InboundGreenApiMessage {
  providerMessageId: string
  chatId: string // нормализованный телефон (только цифры), см. phoneFromGreenApiChatId
  authorName: string | null
  text: string
  messageType?: string
  mediaUrl?: string | null
}

const VOICE_TYPES = new Set(['voice', 'audio', 'audioMessage'])

/** Текст в переписке, когда голосовое пришло, но расшифровать его не вышло. */
const VOICE_UNREADABLE_PLACEHOLDER = '[голосовое сообщение — не удалось расшифровать]'
const IMAGE_TYPES = new Set(['image', 'imageMessage', 'documentMessage'])
const MAX_VOICE_BYTES = 20 * 1024 * 1024
const MAX_RECEIPT_BYTES = 20 * 1024 * 1024

interface ReceiptCheck {
  is_real_receipt_screenshot: boolean
  amount_ok: boolean
  recipient_ok: boolean
  date_ok: boolean
  /** Сумма, которую модель прочитала на чеке. Может не прийти. */
  detected_amount_kgs?: number | null
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
  // Живой баг: файлы до 20 МБ (base64 ~27 МБ payload) на анализ vision-моделью
  // могут не уложиться в дефолтные 15 с — HTTP-таймаут ошибочно читался как
  // "не смогли проверить" вместо честного времени на обработку.
  const result = await smilekitBotFetch<ReceiptCheck>('/internal/verify_receipt', {
    method: 'POST',
    body: { imageBase64: bytes.toString('base64'), today: referenceDate, kind: isPdf ? 'pdf' : 'image', mime },
    timeoutMs: 45_000,
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
    .from('chat_messages')
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

// Живой баг: клиент прислал фото зубов (не чек оплаты), а бот всё равно
// завёл его как заказ «не прошёл проверку» — менеджер в группе доставки и на
// странице «Заказы» видел мусор вместо реальных заявок. Теперь так отвечаем,
// когда автопроверка УСПЕШНО отработала и уверенно говорит «это не скриншот
// оплаты» — заказ в этом случае вообще не заводим (см. handleGreenApiReceipt).
const RECEIPT_NOT_A_RECEIPT =
  'Кажется, это не скриншот чека оплаты 😊 Пришлите, пожалуйста, скриншот перевода — и я оформлю заказ.'

async function transcribeGreenApiVoice(input: InboundGreenApiMessage): Promise<string | null> {
  if (!VOICE_TYPES.has(input.messageType ?? '') || !input.mediaUrl) return input.text
  const response = await fetch(input.mediaUrl, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`greenapi voice download: HTTP ${response.status}`)
  const size = Number(response.headers.get('content-length') || 0)
  if (size > MAX_VOICE_BYTES) throw new Error('greenapi voice download: file is too large')
  const audio = Buffer.from(await response.arrayBuffer())
  if (!audio.length || audio.length > MAX_VOICE_BYTES) throw new Error('greenapi voice download: invalid size')
  const extension = new URL(input.mediaUrl).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? 'ogg'
  // Живой баг: Gemini (распознавание речи) регулярно падал с 429/таймаутом,
  // которые раньше не ретраились на стороне Python (см. _gemini_generate в
  // service.py — исправлено), только 503. Теперь там до 3 попыток с паузой,
  // худший случай — около 65 с; таймаут здесь должен быть выше этого с
  // запасом, иначе Node оборвёт запрос раньше, чем Python успеет доретраить.
  const result = await smilekitBotFetch<{ transcript: string }>('/internal/transcribe', {
    method: 'POST',
    body: { audioBase64: audio.toString('base64'), filename: `voice.${extension}` },
    timeoutMs: 75_000,
  })
  return result.ok ? result.data.transcript.trim() || null : null
}

// ─── Скрипт продаж — те же тексты и правила, что в amoCRM-канале
// (src/lib/amocrm/bot-reply.ts), держим синхронно вручную до объединения
// в общий модуль (см. задачу «обобщить bot-reply.ts под мульти-провайдера»).

const PRODUCT_INFO = DEFAULT_PRODUCT_INFO

/** Случайный вариант из массива паттернов одного и того же ответа — чтобы
 * клиент не видел дословно одинаковый текст при повторном срабатывании
 * триггера. */
function pickVariant<T>(variants: readonly T[]): T {
  return variants[Math.floor(Math.random() * variants.length)]
}

const KYRGYZ_PRODUCT_INFO =
  'Салам! 😊 Бир кутусу — 1490 сом. Ичинде 14 даана тилке бар — бул толук курс. ' +
  'Таасири биринчи колдонуудан кийин эле байкалат.\n\n' +
  'Кайсы шаардан болосуз? Жеткирүү боюнча айтып берем.'

// "тиш" (кырг. "зуб") — единственный маркер здесь короткий настолько, что
// подстрокой ловит русские "тишина"/"тише"/"потише"/"затишье"; тогда
// русскоязычному клиенту уходила явная инструкция ИИ отвечать целиком на
// кыргызском (см. использование isKyrgyz ниже). Границы слова —
// (?<![a-zа-яё0-9_])/(?![a-zа-яё0-9_]), а не \b: в JS \b строится на ASCII
// \w и с кириллицей не работает вообще (см. AFFIRMATIVE_NEGATION выше).
const KYRGYZ_MARKERS =
  /баа|наркы|канча|кайсы|шаар|жеткир|(?<![a-zа-яё0-9_])тиш(?![a-zа-яё0-9_])|агарт|колдон|куту|барбы|алам|керек|рахмат|болобу|кантип|эмне/i
const KYRGYZ_PRICE_INTENT = /баа|наркы|канча\s*(?:сом|турат)/i
const LINK_IN_MESSAGE = /(?:https?:\/\/|www\.)\S+/i
const GREETING_ONLY = /^\s*(?:улыбка|здра(?:в)?ствуйте|здра(?:в)?ствуй|привет|добрый\s+(?:день|вечер|утро))[!,.?\s😊👋]*$/iu

const CITY_QUESTION = 'Подскажите, пожалуйста, из какого вы города?)'

// Отправляется голосовым (.ogg, см. voiceReplies ниже) — клиент текст не
// видит, поэтому вариации бессмысленны, текст только один.
const FIRST_USE_EFFECT = DEFAULT_FIRST_USE_EFFECT

export const LOW_STOCK_DISCOUNT_CTA = DEFAULT_LOW_STOCK_CTA

// Вариации чек-листа оформления — тот же список из трёх пунктов, только
// другая вводная фраза, чтобы один и тот же клиент не видел дословно
// одинаковый текст при повторном заказе.
export const ORDER_CHECKLIST_VARIANTS = [
  DEFAULT_ORDER_CHECKLIST,
  'Для оформления заказа пришлите, пожалуйста 😊\n\n• чек об оплате;\n\n• адрес доставки;\n\n• номер телефона.',
  'Чтобы всё оформить, отправьте мне, пожалуйста 😊\n\n• чек об оплате;\n\n• адрес доставки;\n\n• номер телефона.',
  'Для оформления понадобится 😊\n\n• чек об оплате;\n\n• адрес доставки;\n\n• номер телефона.',
]

const RETURNING_GREETING_REPLIES = [
  'Здравствуйте! 😊 Рада снова вас видеть. Чем могу помочь?',
  'Здравствуйте! 😊 Конечно, я на связи. Что подсказать?',
  'Здравствуйте! 😊 Продолжим — чем могу помочь?',
]

const RETURNING_KYRGYZ_GREETING_REPLIES = [
  'Салам! 😊 Кайрадан көргөнүмө кубанычтамын. Кантип жардам берейин?',
  'Салам! 😊 Мен байланышта элем. Эмне боюнча жардам керек?',
]

const COMPLAINT_PROMPT_VARIANTS = [
  DEFAULT_COMPLAINT_PROMPT,
  'Расскажите, пожалуйста, что именно не понравилось — хотим разобраться и стать лучше.',
  'Подскажите, что пошло не так? Нам важно исправить это и улучшить сервис.',
  'Поделитесь, пожалуйста, что вас не устроило — учтём для улучшения работы.',
]

const COOPERATION_REPLY_VARIANTS = [
  DEFAULT_COOPERATION_REPLY,
  'Спасибо за интерес к сотрудничеству! Опт и партнёрство — это к нашему менеджеру, он свяжется с вами в ближайшее время.',
  'Благодарим за интерес! По вопросам опта и сотрудничества с вами свяжется наш менеджер в ближайшее время.',
  'Спасибо, что написали! Вопросы опта и сотрудничества ведёт наш менеджер — он скоро с вами свяжется.',
]

// Тот же сценарий "effect_duration", что в Telegram-боте (templates.py) —
// «на сколько хватает коробки» отвечаем только стойкостью результата,
// без пересказа цены/состава/количества применений.
const EFFECT_DURATION_QUESTION = /на\s*сколько\s*хватает|сколько\s*(?:держится|длится|хватит)|как\s*долго\s*(?:держится|длится|хватает)/i
const EFFECT_DURATION_VARIANTS = ['До 3 месяцев 😊', 'Эффекта хватает примерно на 3 месяца 😊', 'Держится результат до 3 месяцев 😊', 'Примерно 3 месяца 😊']

// Регионы Кыргызстана/Казахстана вне Бишкека/Токмока едут одной и той же
// «Ылдам Экспресс» — этот же текст служит и явным совпадением по городу,
// и запасным вариантом для сёл/малых населённых пунктов, которых нет и не
// может быть в списке regex (см. REGIONAL_DELIVERY_FALLBACK ниже): раньше
// такие случаи (например, «Село.Арчалы») уходили в ИИ, который сам выдумывал
// сроки и стоимость доставки — теперь только заранее утверждённый текст.
const REGIONAL_DELIVERY_TEMPLATE = 'Да, у нас есть доставка, осуществляется через Ылдам Экспресс 🚚✅\nЗа 1 день доставим прямо до дома.'

// Живой баг: список городов был совсем коротким (по паре на страну), и всё,
// что в него не попадало — включая настоящие города/райцентры — уходило в
// расплывчатую эвристику shouldSendResultsAfterLocation (см. ниже), которая
// с тем же успехом принимала за «город» вообще любую короткую фразу без «?»
// («Отдыхайте» тоже проходило). Список расширен под все страны из
// CLAUDE.md (Кыргызстан/Казахстан/Узбекистан + Россия через СДЭК) —
// известный город теперь узнаётся напрямую, а не по грубому «похоже на
// ответ» правилу.
const OTHER_KZ_REGION_TEMPLATE = 'Да, у нас есть доставка, осуществляется через СДЭК ✅'
const OTHER_UZ_CITY_TEMPLATE = 'Да, у нас есть доставка. В течение 1 дня доставим.\nОсуществляется через БТС Экспресс 🚚'
const RUSSIA_DELIVERY_TEMPLATE = 'Да, у нас есть доставка, осуществляется через СДЭК ✅'

const DELIVERY_TEMPLATES: [RegExp, string][] = [
  // Префиксом, а не целым словом (как остальные города ниже) — живой баг:
  // опечатка «бишкеа» не совпадала с «бишкек» и уходила в общий шаблон
  // «Ылдам Экспресс» вместо доставки по Яндексу. Матчится по normalized
  // ниже, где щ уже сложено в ш — «бищкека» тоже совпадает.
  [/бишке|токмо/, 'Да, у нас есть доставка, по Бишкеку осуществляется через Яндекс 🚚\nПосле оформления будет у вас через 20–40 минут ✅'],
  // Остальной Кыргызстан — райцентры и крупные города вне Бишкека/Токмока.
  [
    /(?<![a-zа-яё0-9_])ош(?![a-zа-яё0-9_])|джалал-?абад|каракол|нарын|талас|баткен|балыкч|манас|кара-?балт|кант(?![а-яё])|кызыл-?кия|узген|кара-?к[уе]л|майлуу-?су|исфана|кочкор|кемин|чолпон-?ата|ат-?баши|сузак|араван|ноокат|айдаркен|сулюкта|кара-?су(?![а-яё])|исык-?кул|иссык-?кул|жалал-?абад/,
    REGIONAL_DELIVERY_TEMPLATE,
  ],
  [/алмат/, 'Да, у нас есть доставка в Алматы 😇📍\nВ течение дня доставим или же в течение 30–40 минут через Яндекс.'],
  [
    /астан|шымкент|караганд|актюбе|актобе|тараз(?![а-яё])|павлодар|усть-?камен|өскемен|оскемен|семей|атырау|костанай|кызылорда|уральск|орал(?![а-яё])|петропавл|актау|темиртау|туркестан/,
    OTHER_KZ_REGION_TEMPLATE,
  ],
  [/ташкент/, 'Да, у нас есть доставка в Ташкенте 😇📍\nВ течение дня доставим или же в течение 30–40 минут через Яндекс.'],
  [
    /самарканд|бухар|андижан|наманган|фергана|нукус|карши(?![а-яё])|термез|ургенч|коканд|жиззах|джиззах/,
    OTHER_UZ_CITY_TEMPLATE,
  ],
  [
    /москв|росси|петербург|питер(?![а-яё])|новосибирск|екатеринбург|казан(?![а-яё])/,
    RUSSIA_DELIVERY_TEMPLATE,
  ],
]

function deliveryTemplateForCity(text: string): string | null {
  // Живой баг: опечатка «бищкека» (щ вместо ш) не совпадала с «бишке» —
  // клиент выпадал из готового шаблона доставки в свободный ответ ИИ.
  // Складываем щ→ш только для матчинга, в тексты клиента и ответы это
  // не идёт.
  const normalized = text.toLowerCase().replace(/щ/g, 'ш')
  for (const [pattern, template] of DELIVERY_TEMPLATES) {
    if (pattern.test(normalized)) return template
  }
  return null
}

// Живой баг: любой короткий ответ без «?» после вопроса о городе считался
// «ответом про город» — так «Отдыхайте» (прощание) и «Давайте оформим»
// (намерение заказать) принимались за название села. Известные города
// теперь распознаются напрямую (см. DELIVERY_TEMPLATES) — эта эвристика
// остаётся только страховкой для настоящих сёл/малых нас. пунктов, которых
// нет и не может быть в конечном списке (см. живой пример «Село.Арчалы»),
// поэтому явные не-города (прощания, благодарности, согласия, намерение
// заказать) исключены явно, а не полагаемся на «короткая фраза = город».
// Живой баг №2: «Хорошо, спасибо» (два слова из блок-листа подряд) не
// совпадало — регекс проверял ровно одно слово в начале/конце строки, а не
// любую комбинацию. Обёртка (?:...)+ ловит любое число таких слов подряд.
export const NOT_A_LOCATION_REPLY =
  /^(?:(?:спасибо|спс|благодар\w*|хорошо|ладно|ок|окей|поняла?|понятно|ясно|отдыхайте|пока|до\s*связи|до\s*свидания|угу|ага|давайте(?:\s+оформ[а-яё]*)?|потом|позже|подума[юем]|извини\w*|прости\w*|удачи|спокойной\s*ночи|доброй\s*ночи|хорошего\s*дня)[\s,!.)😊😉👍🙏]*)+$/i

function shouldSendResultsAfterLocation(text: string, historyText: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ')
  const priorPrice = historyText.includes('цена') || historyText.includes('сом')
  if (!priorPrice || LINK_IN_MESSAGE.test(text) || GREETING_ONLY.test(text)) return false
  if (NOT_A_LOCATION_REPLY.test(normalized)) return false
  if (UNSUPPORTED_COUNTRY.test(normalized)) return false
  const askedForCity = historyText.includes('из какого вы города') || historyText.includes('вы в бишкеке')
  const shortLocationAnswer = !/[?？]/.test(text) && normalized.split(/\s+/).length <= 5
  const deliveryQuestion = /достав|жеткир|отправ|привез/iu.test(text)
  return deliveryQuestion || (askedForCity && shortLocationAnswer)
}

// (?<!слово)оформ\w* — вместо перечисления форм (оформить/оформляйте/
// оформляем). Живой баг №1: «давайте оформим» не совпадало ни с одной из
// перечисленных, уходило в ИИ, который придумывал свой чек-лист без чека/
// адреса. Живой баг №2 (найден позже): исходный фикс использовал \b, а в JS
// \b строится на ASCII \w — перед кириллической буквой (после пробела) обе
// стороны позиции оказываются \W, границы нет, и \bоформ\w* НИКОГДА не
// совпадал ни с чем. Тот же класс бага чинится по всему файлу заменой \b на
// (?<![a-zа-яё0-9_])/(?![a-zа-яё0-9_]) вокруг кириллических слов.
export const ORDER_INTENT =
  /хочу\s+(?:заказать|купить|взять|одну|одн[уо]\s+(?:коробк|пачк|упаковк)|сделать\s+заказ)|(?:как|где|можно)\s+(?:заказать|купить|оформить|оплатить|сделать\s+заказ)|закажу|заказать|куплю|(?<![a-zа-яё0-9_])оформ\w*|(?<![a-zа-яё0-9_])беру(?![a-zа-яё0-9_])|возьму|реквизит|куда\s+(?:скинуть|перевести|оплатить|платить|переводить)|как\s+(?:оплатить|платить|оплачивать)|способ\s+оплаты|оплачу|готов[аы]?\s+(?:оплатить|купить|заказать)|номер\s+карты|скин(?:ь|ьте)\s+(?:номер|реквизит|карту|qr)|\bqr[\s-]?код/i

// Живой баг: «Мы можем завтра оформить заказ?» — вопрос про будущее, а
// «оформить» в тексте всё равно совпадало с ORDER_INTENT и гнал прямо к
// чек-листу с QR, хотя клиент ещё не готов платить сейчас. Вопрос
// («можем/можно ли... завтра/позже... оформить») с явным словом
// будущего — не сигнал «оформляйте прямо сейчас», отдаём ИИ, который уже
// умеет вежливо ответить «конечно, будем ждать» (см. prompts.py).
export const FUTURE_ORDER_QUESTION =
  /(?:можем|можно|получится|успе[юем]{2})\s+(?:ли\s+)?(?:завтра|эртен|позже|попозже|послезавтра|на\s+следующей\s+неделе)[^?]*оформ|оформ[^?]*(?:завтра|эртен|позже|попозже|послезавтра|на\s+следующей\s+неделе)[^?]*\?/i

// Живой баг: клиент прямо просит оплату при получении («хочу оплатить
// после того, как приеду», «можно адрес?» — тот же маркер, что уже описан
// в prompts.py для ИИ-канала), а ORDER_INTENT (тоже совпадает — «оплатить»
// в тексте есть) всё равно гнал к чек-листу с QR и требованием чека —
// клиент явно попросил оплату при получении, а получил требование
// предоплаты. Эта проверка стоит раньше ORDER_INTENT в цепочке ответов.
// Живой баг: регекс ловил только форму «оплачу», а реальные клиенты (два
// случая в истории чатов) писали «оплатить» (инфинитив) — \w-класс тут ни
// при чём, просто не предусмотрели форму. [а-яё]* вместо жёсткого списка
// окончаний покрывает оплачу/оплатить/оплачивать и т.п. разом.
export const PAY_ON_DELIVERY_REQUEST =
  /(?:оплат[а-яё]*|заплач[а-яё]*)\s*(?:ли\s+)?(?:после|как\s+только|когда|при)[^.!?\n]{0,25}(?:приед|получ|доставк|привез)|оплат[ауы]?\s*при\s*получении|можно\s*(?:просто\s*)?адрес\s*\??|наличными\s*(?:курьеру|при\s*получении)|оплачу\s*курьеру/i
const PAY_ON_DELIVERY_ACK_REPLY =
  'Хорошо, оплата при получении 😊 Пришлите, пожалуйста, адрес доставки и номер телефона — оформлю доставку.'
const COD_WAIT_ANCHOR_ID_PREFIX = 'ga:claim:cod-wait'
const COD_WAIT_ANCHOR_TEXT = '[ожидание адреса — оплата при получении]'

// После того как заказ реально оформлен (чек принят или подтверждена оплата
// при получении — см. оба места записи ORDER_PLACED_ANCHOR_ID_PREFIX ниже),
// бот больше не придумывает статус доставки сам — этого он не знает, знает
// курьер/менеджер в группе доставки. На вопросы про доставку/курьера дальше
// молчим (отвечает человек), на остальные вопросы бот продолжает отвечать
// как обычно.
const ORDER_PLACED_ANCHOR_ID_PREFIX = 'ga:claim:order-placed'
const POST_ORDER_DELIVERY_QUESTION =
  /достав\w*|курьер\w*|привез(?:ут|ли|ёте|ете)?|отправ(?:или|лен\w*|ьте)?|где\s+(?:мой\s+)?заказ|когда\s+(?:буд|прид|приед|получ)/iu

async function hasPlacedOrder(supabase: ReturnType<typeof createAdminClient>, chatId: string): Promise<boolean> {
  const { data } = await supabase
    .from('chat_messages')
    .select('id')
    .eq('amo_message_id', `${ORDER_PLACED_ANCHOR_ID_PREFIX}:${chatId}`)
    .maybeSingle()
  return Boolean(data)
}

async function markOrderPlaced(supabase: ReturnType<typeof createAdminClient>, chatId: string): Promise<void> {
  await supabase.from('chat_messages').upsert({
    amo_message_id: `${ORDER_PLACED_ANCHOR_ID_PREFIX}:${chatId}`,
    chat_id: chatId,
    direction: 'out',
    sender: 'bot',
    text: '[заказ оформлен]',
  }, { onConflict: 'amo_message_id' })
}

// Короткое согласие само по себе намерения не выражает («давайте» может
// относиться к чему угодно) — засчитываем его как заказ, только если прошлое
// сообщение бота было предложением оформить. Иначе ответ уходил в ИИ и клиент
// вместо чек-листа получал произвольную формулировку. Живой баг: «давайте»
// само по себе не ловилось, если перед ним стояло филлер-слово («Ладно
// давайте», «Ну давайте», «Хорошо, давайте») — с точки зрения regex это уже
// не «просто одно слово согласия», и ответ уходил в ИИ, которая иногда не
// присылала QR и путала чек-лист. Опциональный филлер впереди — то же
// согласие, тот же смысл.
const AFFIRMATIVE_ONLY =
  /^\s*(?:ладно|ну|хорошо|окей|ок)?[\s,]*(?:да|ага|угу|давай(?:те)?|ок(?:ей)?|хорошо|конечно|согласен|согласна|можно)[\s!.,)😊👍]*$/i
// Живой баг: после «Вам оформить доставку?» клиент отвечает не одним словом,
// а «Да, давайте», «Да хочу», «Да\nБишкек, ул. Ленина 5» (несколько пузырей
// склеиваются 50-секундным буфером) — строгий AFFIRMATIVE_ONLY не совпадал,
// сообщение уходило в ИИ, и тот вместо шаблона с чек-листом и QR сочинял
// свой текст. Мягкая проверка: есть слово согласия, нет отказа и вопроса,
// сообщение короткое. Применяется ТОЛЬКО если прошлое сообщение бота было
// предложением оформить (или концом блока результата) — иначе «да» может
// относиться к чему угодно.
const AFFIRMATIVE_WORD =
  /(?:^|[\s,.!(])(?:да|ага|угу|давай(?:те)?|ок(?:ей)?|хорошо|конечно|согласен|согласна|можно|хочу|буду|готов[аы]?|оформляйте|оформите)(?=$|[\s,.!)😊👍\n])/i
const AFFIRMATIVE_NEGATION = /(?<![a-zа-яё0-9_])не(?![a-zа-яё0-9_])|(?<![a-zа-яё0-9_])нет(?![a-zа-яё0-9_])|потом|позже|подумаю|пока\s+нет|не\s+надо|\?/i
function isLooseAffirmative(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean)
  return words.length <= 10 && AFFIRMATIVE_WORD.test(text) && !AFFIRMATIVE_NEGATION.test(text)
}
// Ответ «нет» на CTA ORDER_CTA_TEXT — тоже уходит в лестницу
// скидок (nextDiscountOffer), как и прямая просьба ниже.
const NEGATIVE_ONLY = /^\s*(?:нет|неа|не\s+хочу|не\s+буду|не\s+надо|откажусь|подумаю)[\s!.,)😔👎]*$/i
// Прямая просьба о скидке или сигнал «дорого/не хватает денег» — та же
// лестница 13%→20%, что и отказ на follow-up: раньше такие сообщения не
// были в скрипте вовсе, уходили в ИИ, который мог вообще проигнорировать
// скидку, ответить не по теме, или (живой баг) сразу дать 20% в обход
// 13% — MANAGER_PROMPT требует именно 13% первым шагом, но свободная
// генерация это правило иногда нарушала.
const DISCOUNT_REQUEST =
  /скидк|дешевле|подешевле|уступ\w*\s*(?:в\s*цен|цену)|акци[юя]|дорого|не\s*хватает\s*денег|нет\s*денег|не\s*могу\s*себе\s*позволить|денег\s*не\s*хватает/i
// ИИ формулирует призыв по-разному: «Оформить вам?», «Вам оформить доставку?»,
// «Оформить?» — привязка к точному порядку слов не работала, и согласие
// клиента уходило в ИИ вместо чек-листа.
const ORDER_CTA_MARKER = /оформ\w*[^.!?]*\?/i

// Признаки того, что ИИ в свободном ответе сам начал оформление заказа:
// просит чек/адрес/телефон/реквизиты или описывает оплату. Такой ответ
// заменяется шаблоном ORDER_CHECKLIST + QR (см. generateAndSendGreenApiReply).
// Живой баг: [^.!?\n] явно исключал перенос строки, а реальные
// ИИ-чек-листы почти всегда оформлены списком с переносами («напишите...\n\n
// Адрес доставки\nНомер телефона») — регекс не мог сматчиться через перенос,
// и «чек об оплате» выпадал из ответа ИИ незамеченным (клиенту прислали
// только адрес+телефон, менеджеру пришлось руками дописывать «и чек»).
// [^.!?] без \n в исключениях — та же защита от переползания на соседние
// предложения, но перенос строки внутри списка теперь не обрывает совпадение.
export const AI_IMPROVISED_CHECKLIST =
  /(?:чек|скриншот)[^.!?]{0,40}(?:оплат|перевод)|(?:адрес|номер\s+телефона)[^.!?]{0,40}(?:чек|оплат)|реквизит|(?:пришлите|отправьте|напишите|укажите|скиньте)[^.!?]{0,40}(?:адрес|чек|номер\s+телефона)|(?:для|чтобы)\s+оформ\w*[^.!?]{0,60}(?:нужн|пришлите|отправьте|укажите)/i

// Живой баг: клиент пришёл по рекламе (Instagram-«Click-to-WhatsApp»), где
// Meta сама шлёт авто-приветствие ДО первого сообщения клиента — это ломало
// history.length===0 (см. фикс в registerOutgoingGreenApiMessage выше) и
// уводило первый настоящий вопрос клиента в ИИ-фолбэк вместо приветствия.
// ИИ там САМ, без единого слова о скидке от клиента, предложил 13% — хотя
// MANAGER_PROMPT и SUPERVISOR_PROMPT это прямо запрещают. Промпт — не
// гарантия: ИИ-самопроверка (SUPERVISOR_PROMPT) в этом самом случае тоже не
// сработала. Это код-level страховка на тот же класс ошибки, а не только
// upstream-фикс истории — если цена вообще ещё не звучала в переписке, а
// клиент скидку не просил (DISCOUNT_REQUEST), самовольная скидка от ИИ
// заведомо неуместна и заменяется на обычное приветствие с ценой.
export const AI_IMPROVISED_DISCOUNT = /скидк|1290|1190|13\s*%|20\s*%/i

// Подводка перед фото — дословно как в Telegram (__main__.py).
const RESULTS_INTRO = 'Вот такой эффект будет уже после первого применения 👇'

// ИИ-фолбэк отвалился дважды подряд — честный текст вместо полной тишины
// (см. живой баг в generateAndSendGreenApiReply: клиент спросил «А какой
// адрес?», ответа не было 6 часов, пока не написал то же самое повторно).
const FALLBACK_AI_FAILURE_REPLY = 'Извините, не расслышала 😊 Уточните, пожалуйста, ещё раз?'

// CTA «вам оформить доставку?», который бот сам предлагает в ходе диалога.
// Скидку сама по себе не предлагаем — только если клиент на этот вопрос
// ответит отказом (NEGATIVE_ONLY ниже).
export const ORDER_CTA_TEXT = 'Вам оформить доставку?'
// Тот же якорный приём, что ga:claim:*, но для вопроса CITY_QUESTION:
// если клиент не назвал город 5 минут, followup-scheduler.ts сам присылает
// блок «до/после» (без доставки и голосового — город ещё не известен),
// чтобы не терять клиента, который застрял на этом вопросе молча.
export const CITY_WAIT_ANCHOR_ID_PREFIX = 'ga:claim:city-wait'
export const CITY_WAIT_ANCHOR_TEXT = '[ожидание города]'
export function pickOrderCta(): string {
  return ORDER_CTA_VARIANTS[Math.floor(Math.random() * ORDER_CTA_VARIANTS.length)]
}
// Вариации того же вопроса — используются при отправке (см. ORDER_CTA_VARIANTS
// ниже); ORDER_CTA_TEXT остаётся как канонический текст для обратной
// совместимости, но выбор варианта и проверка «это был CTA?» идут по
// массиву ORDER_CTA_VARIANTS.includes(...), а не по точному совпадению.
export const ORDER_CTA_VARIANTS = [
  ORDER_CTA_TEXT,
  'Оформляем доставку?',
  'Оформить вам заказ с доставкой?',
  'Готовы оформить доставку?',
]

// После блока результата (фото до/после + голосовое) бот больше не пишет
// сам ничего — ни CTA, ни дожима, ни скидок (см. isAwaitingPostResultsReply
// ниже). Первый же ответ клиента после этого сразу уходит менеджеру в
// рабочую группу «Передача от бота» (handOffToManager).
export const POST_RESULTS_STAGE_ANCHOR_ID_PREFIX = 'ga:claim:post-results-stage'
export const HANDED_OFF_ANCHOR_ID_PREFIX = 'ga:claim:handed-off'

async function isHandedOffToManager(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('chat_messages')
    .select('id')
    .eq('amo_message_id', `${HANDED_OFF_ANCHOR_ID_PREFIX}:${chatId}`)
    .maybeSingle()
  return Boolean(data)
}

async function buildHandoffCardText(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string,
  lastMessageText: string
): Promise<string> {
  const { data: historyRows } = await supabase
    .from('chat_messages')
    .select('text, sender')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true })
    .limit(200)
  const historyText = ((historyRows ?? []) as { text: string; sender: string }[])
    .map((row) => row.text)
    .join(' ')
    .toLowerCase()
    .replace(/щ/g, 'ш')
  let city = ''
  for (const [pattern] of DELIVERY_TEMPLATES) {
    if (pattern.test(historyText)) {
      const match = historyText.match(pattern)
      if (match) {
        city = match[0]
        break
      }
    }
  }
  return (
    'Новый клиент для менеджера\n' +
    `Номер: +${chatId}\n` +
    `Город: ${city || 'не указан'}\n` +
    `Последнее сообщение: «${lastMessageText}»`
  )
}

async function sendHandoffCard(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string,
  lastMessageText: string
): Promise<void> {
  const botConfig = await getWhatsappBotConfig()
  if (!botConfig.handoffGroupId) return
  const cardText = await buildHandoffCardText(supabase, chatId, lastMessageText)
  try {
    await withRetries(() => sendGreenApiDeliveryGroup(botConfig.handoffGroupId, cardText))
  } catch (error) {
    console.error('greenapi bot-reply: handoff card send failed after retries', error)
  }
}

/**
 * Клиент ответил на CTA/дожим/скидку из пост-результатной цепочки — дальше
 * бот эту переписку не ведёт вообще, карточка клиента уходит в рабочую
 * группу «Передача от бота», а дальше отвечает менеджер (см. документ
 * «Логика бота — первичный контакт», п. 6–11).
 */
async function handOffToManager(
  supabase: ReturnType<typeof createAdminClient>,
  input: InboundGreenApiMessage
): Promise<void> {
  await supabase.from('chat_messages').upsert({
    amo_message_id: `${HANDED_OFF_ANCHOR_ID_PREFIX}:${input.chatId}`,
    chat_id: input.chatId,
    direction: 'out',
    sender: 'bot',
    text: '[передано менеджеру]',
  }, { onConflict: 'amo_message_id' })
  // Цепочка дожима больше не нужна — менеджер уже в курсе, дальнейшие
  // автоматические шаги (актуально?/скидки) только мешали бы.
  await supabase.from('chat_messages').delete().eq('amo_message_id', `${POST_RESULTS_STAGE_ANCHOR_ID_PREFIX}:${input.chatId}`)
  await sendHandoffCard(supabase, input.chatId, input.text)
}

const HANDOFF_REMINDER_INTERVAL_MS = 24 * 60 * 60_000

/**
 * Клиент продолжает писать уже после передачи менеджеру — карточку не
 * дублируем на каждое такое сообщение (иначе группа завалена одним и тем же
 * клиентом), но если менеджер за сутки так и не среагировал, шлём то же
 * напоминание повторно, а не молча теряем зависшего клиента. Возвращает
 * true, если чат передан менеджеру (бот его дальше не обрабатывает) —
 * вне зависимости от того, ушло ли в этот раз напоминание.
 */
async function maybeRemindHandoff(
  supabase: ReturnType<typeof createAdminClient>,
  input: InboundGreenApiMessage
): Promise<boolean> {
  const { data } = await supabase
    .from('chat_messages')
    .select('id, created_at')
    .eq('amo_message_id', `${HANDED_OFF_ANCHOR_ID_PREFIX}:${input.chatId}`)
    .maybeSingle()
  if (!data) return false
  const { id, created_at } = data as { id: number; created_at: string }
  if (Date.now() - new Date(created_at).getTime() >= HANDOFF_REMINDER_INTERVAL_MS) {
    await supabase.from('chat_messages').update({ created_at: new Date().toISOString() }).eq('id', id)
    await sendHandoffCard(supabase, input.chatId, input.text)
  }
  return true
}

// Живой баг: клиент сам сказал «завтра»/«эртен» (Telegram-бот это уже умеет,
// см. promised_clock_time_hours/promised_calendar_date_hours в sales.py) —
// а общий 30-минутный дожим в WhatsApp этого не знал и всё равно писал
// «Возвращаясь к нашему разговору...» посреди дня, хотя клиент только что
// договорился вернуться позже. Грубая эвристика (не парсим точное время,
// просто не дёргаем клиента раньше правдоподобного срока) — этого достаточно,
// чтобы не выглядеть навязчиво.
const PROMISED_LATER_HOURS: [RegExp, number][] = [
  [/завтра|эртен/i, 18],
  [/вечером|кечинде/i, 5],
  [/через\s*час\b/i, 1.5],
  [/на\s+(?:этой\s+|следующей\s+)?неделе|на\s+днях/i, 48],
  [/по[зс]же|попозже|потом(?:\s+напишу)?/i, 3],
]
export const PROMISED_ANCHOR_ID_PREFIX = 'ga:claim:promised'

/** Сколько часов не дёргать клиента дожимом — null, если клиент ничего не обещал. */
function promisedDelayHours(text: string): number | null {
  const explicitHours = text.match(/через\s+(\d{1,2})\s*ч/i)
  if (explicitHours) return Math.min(48, Number(explicitHours[1]) + 0.5)
  for (const [pattern, hours] of PROMISED_LATER_HOURS) {
    if (pattern.test(text)) return hours
  }
  return null
}

// Дожим, если клиент молчит 30 минут после ЛЮБОГО последнего ответа бота
// (в т.ч. после CTA-follow-up — но и на любом другом этапе диалога), как
// idle_nudge в Telegram-боте (__main__.py). Несколько вариантов текста, а не один и тот же — раньше повторный
// дожим (после того, как клиент снова замолчал уже после ответа на первый)
// слал буквально то же самое сообщение; ротация по номеру попытки убирает
// повтор. Если клиент вообще не ответил на дожим 24 часа — вторая волна не
// повторяет тот же текст, а сразу предлагает скидку (та же лестница
// 13%→20%, что и nextDiscountOffer) — как в обычной email/WhatsApp-рассылке.
export const IDLE_NUDGE_VARIANTS = [
  'Вы ещё здесь? 😊 Если что-то ещё интересует — с радостью подскажу, оформим, когда будете готовы 😊',
  'Возвращаясь к нашему разговору 😊 Если ещё актуально — обсудим детали и оформим заказ.',
  'На связи, если появились вопросы перед заказом 😊 Что скажете?',
]

// Скидка — та же двухступенчатая лестница, что в Telegram-боте (templates.py
// DISCOUNT_OFFER/DISCOUNT_OFFER_FINAL): сначала 13%, только при повторном
// отказе — 20% (максимум), дальше — фиксированный отказ, а не выдумка ИИ.
// Тексты идентичны Telegram для единообразия между каналами.
export const DISCOUNT_OFFER_13_TEXT = 'Хорошо, сделаю для вас скидку 13% — 1290 сом вместо 1490 сом. Оформляем?'
export const DISCOUNT_OFFER_20_TEXT = 'Хорошо, для вас сделаю специальную цену — 1190 сом вместо 1490 сом. Такое предлагаю нечасто. Оформляем?'
export const DISCOUNT_REJECT_TEXT = 'Дешевле, к сожалению, не могу — 1190 сом уже максимальная скидка. Оформляем по этой цене?'

// Якорь ставится один раз сразу после блока результата (см. запись
// POST_RESULTS_STAGE_ANCHOR_ID_PREFIX ниже по файлу) и снимается либо тут
// (handOffToManager), либо никогда автоматически не продвигается —
// followup-scheduler.ts эту стадию больше не трогает.
async function isAwaitingPostResultsReply(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('chat_messages')
    .select('id')
    .eq('amo_message_id', `${POST_RESULTS_STAGE_ANCHOR_ID_PREFIX}:${chatId}`)
    .maybeSingle()
  return Boolean(data)
}

// Реальный текст уже отправленной и сработавшей рассылки (campaigns.message,
// «Скидка 13 процентов 🐇», completed) — переиспользуем его же, а не
// придумываем новый: после того как скидочная лестница исчерпана (клиент
// не ответил даже на максимум), дальше вместо молчания раз в 24 часа
// уходит этот же текст, как в обычной email/WhatsApp-рассылке.
export const POST_DISCOUNT_CAMPAIGN_TEXT =
  'Кстати, остались 3 пачки, и на них сделаем скидку 13%\n' +
  'Со скидкой 1290сом\n\n' +
  'Если давно смущает желтизна зубов на фото или вживую — это можно быстро исправить, результат уже за 30 минут 😍\n\n' +
  'Оформить вам одну пачку?'

// Префикс id сообщений дожима — по нему followup-scheduler.ts узнаёт, что
// последнее сообщение чата уже само было дожимом (а не обычным ответом),
// и переходит ко второй волне (скидка), а не повторяет первую.
export const IDLE_NUDGE_ID_PREFIX = 'ga:bot:idle-nudge'

/** Сколько дожимов уже уходило в этот чат — для ротации IDLE_NUDGE_VARIANTS. */
async function countPreviousIdleNudges(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string
): Promise<number> {
  const { count } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('chat_id', chatId)
    .like('amo_message_id', `${IDLE_NUDGE_ID_PREFIX}%`)
  return count ?? 0
}

/**
 * Что слать в качестве дожима, когда клиент молчит после lastBotText/
 * lastBotAmoMessageId (последнее реальное сообщение бота в чате):
 * - последним уже был дожим, и это был DISCOUNT_REJECT_TEXT или сам
 *   POST_DISCOUNT_CAMPAIGN_TEXT (скидочная лестница исчерпана, клиент
 *   молчит) — дальше вместо новых уступок раз в 24 часа уходит один и тот
 *   же текст рассылки (POST_DISCOUNT_CAMPAIGN_TEXT), как обычная
 *   WhatsApp-рассылка, а не повтор отказа до бесконечности;
 * - последним уже был дожим (клиент не ответил вовсе за отведённое время) —
 *   вторая волна: скидка по лестнице, а не повтор того же текста;
 * - последним было предложение 13% (клиент не ответил) — сразу 20%;
 * - иначе — обычный дожим, вариант по счётчику, чтобы не повторяться при
 *   разных периодах молчания в одном чате.
 */
export async function nextIdleNudgeReply(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string,
  lastBotText: string,
  lastBotAmoMessageId: string
): Promise<string | null> {
  if (lastBotAmoMessageId.startsWith(IDLE_NUDGE_ID_PREFIX)) {
    if (lastBotText === DISCOUNT_REJECT_TEXT || lastBotText === POST_DISCOUNT_CAMPAIGN_TEXT) {
      return POST_DISCOUNT_CAMPAIGN_TEXT
    }
    return nextDiscountOffer(supabase, chatId)
  }
  if (lastBotText === DISCOUNT_OFFER_13_TEXT) return nextDiscountOffer(supabase, chatId)
  const attempt = await countPreviousIdleNudges(supabase, chatId)
  return IDLE_NUDGE_VARIANTS[attempt % IDLE_NUDGE_VARIANTS.length]
}

// Тот же набор, что уходит альбомом в Telegram (media.result_photo_group).
// WhatsApp альбомов не поддерживает — шлём по одному; подписи «До»/«После»
// нужны, потому что без album-группировки порядок иначе не читается.
const RESULT_PHOTOS: readonly (readonly [string, string])[] = [
  ['before_after.jpg', ''],
]

// Отправляется голосовым (.ogg, см. voiceReplies ниже) — клиент текст не
// видит, поэтому вариации бессмысленны, текст только один.
const DOUBT_RESULT_REPLY = DEFAULT_DOUBT_RESULT_REPLY

export const SCAM_DOUBT =
  /(?:вы\s+)?(?:точно\s+)?не\s+мошенник|мошенники\s*\?|(?:это\s+)?(?:точно\s+)?не\s+(?:обман|развод|скам|фейк)|без\s+обмана|(?:это\s+)?(?:все|всё)?\s*реально\s*(?:да|\?)|не\s+кин[её]те|вам\s+можно\s+доверять|можно\s+(?:ли\s+)?вам\s+верить|вы\s+настоящие/i

// Тот же роутер-сценарий "safety_composition", что в Telegram-боте
// (service.py ROUTE_TOOL): вопрос про состав/безопасность/вред для эмали
// или дёсен. Раньше в WhatsApp такой ветки не было вовсе — вопрос уходил в
// ИИ, который сочинял свой ответ вместо утверждённого текста.
// Вопрос сформулирован через «вред»/«опасно» (отрицательная рамка, «вредно
// для эмали?», «не опасно?») — на такой вопрос естественно звучит голосовое
// (оно начинается с «нет, конечно»). Вопрос через «безопасно» (утвердительная
// рамка, «это безопасно?») — «нет, конечно» в ответ прозвучит наоборот,
// как подтверждение опасности, поэтому здесь остаётся только текст.
export const SAFETY_COMPOSITION_HARM_DOUBT =
  /вред(?:ит|но|ен)?[^.!?]{0,15}(?:эмал|дёсн|десн)|(?:эмал|дёсн|десн)[^.!?]{0,15}вред|опасн\w*[^.!?]{0,15}(?:эмал|дёсн|десн|состав)/i
export const SAFETY_COMPOSITION_SAFE_DOUBT =
  /безопасн\w*[^.!?]{0,15}состав|состав[^.!?]{0,15}безопасн/i
const SAFETY_COMPOSITION_DOUBT = new RegExp(
  `${SAFETY_COMPOSITION_HARM_DOUBT.source}|${SAFETY_COMPOSITION_SAFE_DOUBT.source}`,
  'i'
)

export const SAFETY_COMPOSITION_VARIANTS = [
  DEFAULT_SAFETY_COMPOSITION,
  'Состав полностью безопасен и никак не вредит эмали зубов. То фото результата, что я присылала, — это мои собственные зубы 😊 Могу прислать состав, если интересно.',
  'Не переживайте, состав абсолютно безопасный, эмаль не повреждает. Результат на фото — мои собственные зубы. Хотите — пришлю состав.',
  'Состав у нас безопасный, эмали не вредит совсем. И фото результата, которое я отправляла, — это мои собственные зубы. Если нужно, отправлю состав.',
]

// Второе голосовое в блоке результата (после доставки → фото до/после →
// «гарантированно увидите эффект…») — проактивно снимает возражение про
// безопасность состава, не дожидаясь вопроса. Отдельный текст (а не один
// из SAFETY_COMPOSITION_VARIANTS выше) — иначе оба места отправки не
// различить по одному только тексту при выборе имени голосового файла.
export const RESULTS_BLOCK_SAFETY_TEXT =
  'Состав у нас полностью безопасный, эмаль не повреждает — можем прислать состав, если интересно.'

// Живой баг: клиент спросил стоимость/платность доставки отдельно от
// названия города («Имею ввиду доставку») — ИИ-фолбэк выдумал «бесплатно»,
// хотя в базе знаний доставки такого нет (только «оплата при получении» по
// Бишкеку/Токмоку или предоплата 400 сом для остальных регионов КР). Теперь
// это детерминированная ветка — деньги не оставляем на усмотрение ИИ.
const DELIVERY_COST_QUESTION =
  /сколько\s*(?:будет|стоит|выйдет)[^?]{0,20}достав|достав\w*[^?]{0,15}(?:плат|бесплат)|(?:плат|бесплат)\w*[^?]{0,15}достав|имею\s*ввиду\s*доставк/i
export const DELIVERY_PAYMENT_BISHKEK = 'Доставка курьером, оплата — при получении 😊'
const DELIVERY_PAYMENT_REGIONS = 'По регионам — предоплата 400 сом, остальная сумма при получении 😊'

// Клиент прямо спрашивает, бесплатна ли доставка — отдельно от общего
// DELIVERY_COST_QUESTION (тот отвечает способом оплаты, не ценой): здесь
// нужен именно ответ на «бесплатно?», с готовым предложением скидки на
// товар, а не пересказ способа оплаты не по теме вопроса.
const DELIVERY_FREE_QUESTION = /достав\w*[^?]{0,15}бесплат|бесплат\w*[^?]{0,15}достав/i
const DELIVERY_FREE_DISCOUNT_REPLY =
  'К сожалению, бесплатной доставки нет 😊 Но можем сделать скидку 200 сом на товар — получится 1290 сом, ' +
  'и с учётом доставки выйдет примерно как обычная цена. Оформляем?'

// Клиент спрашивает про самовывоз — точки/склада для выдачи нет, мы онлайн-
// магазин, работаем только через курьерскую доставку. Оплата при получении
// как альтернатива самовывозу — та же гарантия «не платить вперёд», просто
// без визита клиента к нам.
export const PICKUP_QUESTION = /самовывоз|сам\w*\s*забра\w*|забра\w*\s*сам\w*/i
const PICKUP_REPLY =
  'Самовывоза нет, мы онлайн-магазин без точки выдачи 😊 Но можем сделать оплату при получении — курьер привезёт, оплатите на месте.'

// Живой баг: клиент спросил «А какой адрес?», это не совпадало ни с одним
// шаблоном (PAY_ON_DELIVERY_REQUEST ждёт «можно адрес?», не голый вопрос) —
// уходило в ИИ-фолбэк, а тот ответил расплывчато. Клиент на самом деле
// спрашивает, какие данные от него нужны — отвечаем конкретной инструкцией,
// а не переспрашиваем и не гадаем.
export const ADDRESS_QUESTION = /^\s*(?:а\s+)?как(?:ой|ая)?\s+адрес\s*[?？]?\s*$|^\s*адрес\s*[?？]\s*$/i
const ADDRESS_QUESTION_REPLY =
  'Напишите, пожалуйста, ваш адрес и номер телефона одним сообщением — оформим доставку 😊'

// Живой баг: клиент спросил про страну, куда доставки нет («Германия,
// привезёте?») — «привез»/«достав» в тексте включало deliveryQuestion в
// shouldSendResultsAfterLocation, и бот врал про доставку через «Ылдам
// Экспресс» за 1 день, хотя товар продаётся только в Кыргызстане,
// Казахстане, Узбекистане (Россия — отдельно, через СДЭК от 7 дней, без
// местного склада). Список — только явно «дальнее зарубежье», чтобы не
// зацепить реальные города/сёла КР/КЗ/УЗ по случайному совпадению.
export const UNSUPPORTED_COUNTRY =
  /герман|немец|сша\b|америк|европ|англи|британ|франц|итали|испани|канад|австрали|турци|оаэ|дубай|китат|кита[йя]|коре[яи]/i
const UNSUPPORTED_COUNTRY_REPLY = 'К сожалению, в другие страны доставки пока нет.'

const COMPLAINT =
  /развод|обман(?:ули)?|кинул|мошенник|верните\s+деньги|хочу\s+возврат|ужасн(?:о|ый|ая)|отвратительн|никогда\s+(?:больше\s+)?не\s+куплю|не\s+помогл|разочарован/i
const COOPERATION =
  /сотрудничеств|оптом|(?<![a-zа-яё0-9_])опт(?![a-zа-яё0-9_])|дистрибьютор|дилер|партн[её]р|реселлер|перепродаж|b2b|блогер/i

// Странные/нетипичные вопросы (документы, лицензия, юр. регистрация и
// т.п., не про безопасность состава — та ветка отдельно, SAFETY_COMPOSITION_
// DOUBT) — бот молчит полностью и сделка уходит на "нестандартный запрос",
// как при жалобе/сотрудничестве, вместо того чтобы ИИ пытался сам ответить
// не по скрипту.
const SUSPICIOUS_QUESTION =
  /докумен\w*|лицензи\w*|сертификат\w*\s*(?:компани|организаци|юр)|регистрац\w*\s*(?:компани|ип(?![a-zа-яё0-9_])|ооо|бизнес)|огрн|(?<![a-zа-яё0-9_])инн(?![a-zа-яё0-9_])|устав\w*\s*(?:компани|организаци)|юридическ\w*\s*(?:адрес|лицо)|свидетельств\w*\s*(?:о\s*регистрации)/i

const READY_TO_BUY = /оформ(?:ить|ляйте)|заказ(?:ать|ываю)?|беру(?![a-zа-яё0-9_])|покупаю(?![a-zа-яё0-9_])|заброниру|резервиру/i
const INTEREST_CONFIRMED = /хочу(?![a-zа-яё0-9_])|подходит|устраивает|интересует|готов\s+(?:взять|купить)|давайте/i
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
// Живой баг (09.09): массовая рассылка «Кстати, остались 3 пачки...» (не
// через наши campaigns — отправлена мимо CRM напрямую с номера) ушла ~400
// клиентам за час. Каждая такая отправка ловилась вебхуком как обычное
// сообщение живого менеджера (sender='operator') — и isManagerControllingChat
// решала, что менеджер теперь ведёт ВСЕ эти чаты сам, бот замолкал у всех
// разом. Отличить рассылку от реального ответа человека можно по факту: один
// и тот же текст слово-в-слово улетает в много РАЗНЫХ чатов почти
// одновременно — человек так не печатает. Помечаем совпавшие по этому
// признаку отправки отдельным author_name, чтобы isManagerControllingChat их
// не считала передачей менеджеру.
export const BULK_BROADCAST_AUTHOR_MARKER = '[система: похоже на массовую рассылку]'
const BULK_BROADCAST_DETECT_WINDOW_MS = 3 * 60_000
const BULK_BROADCAST_DISTINCT_CHATS_THRESHOLD = 3

/** Тот же текст ушёл (или уходит) хотя бы в столько же ДРУГИХ чатов за окно
 * BULK_BROADCAST_DETECT_WINDOW_MS — человек так писать не может, это рассылка. */
export function isBulkBroadcast(distinctOtherChatsWithSameText: number): boolean {
  return distinctOtherChatsWithSameText >= BULK_BROADCAST_DISTINCT_CHATS_THRESHOLD - 1
}

export async function registerOutgoingGreenApiMessage(input: InboundGreenApiMessage): Promise<void> {
  const supabase = createAdminClient()
  // Окно эха расширено с 5 минут до суток: под нагрузкой (см. BotToggle,
  // getDealConversation — тот же класс зависаний сервера) собственная
  // отправка бота иногда фактически уходит клиенту с большой задержкой —
  // на живых данных зафиксирован разрыв 21+ минуту между сообщением клиента
  // и приходом эха. Опоздавшее эхо не находило себе пару в 5-минутном окне
  // и записывалось как сообщение живого менеджера — бот замолкал в этом
  // чате НАВСЕГДА (isManagerControllingChat), хотя ответил он сам. Точное
  // совпадение текста практически исключает случайное совпадение с реальным
  // сообщением человека.
  const { data: recentBot } = await supabase
    .from('chat_messages')
    .select('id')
    .eq('chat_id', input.chatId)
    .eq('sender', 'bot')
    .eq('text', input.text)
    .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
    .limit(1)
  if (recentBot?.length) return // эхо нашей же отправки

  // Живой баг: клиент пришёл по рекламе «Click-to-WhatsApp» из Instagram —
  // Meta сама шлёт автоматическое приветствие («напишите слово "Улыбка"...»)
  // ДО того, как клиент вообще что-то написал. Это исходящее сообщение не от
  // нашего бота — записывалось как sender='operator', и следующий реальный
  // первый вопрос клиента после него уже не считался «первым сообщением»
  // (history.length === 0 переставало быть true) — уходил в ИИ-фолбэк вместо
  // приветствия с ценой, а ИИ ещё и сам предлагал скидку, которую никто не
  // просил (MANAGER_PROMPT это прямо запрещает). Признак: живой оператор не
  // может написать раньше, чем клиент хоть что-то прислал в этот чат — если
  // входящих от клиента ещё не было вообще, это не человек, а автоматика
  // рекламной платформы, и в историю чата её включать не нужно.
  const { data: anyClientMessage } = await supabase
    .from('chat_messages')
    .select('id')
    .eq('chat_id', input.chatId)
    .eq('direction', 'in')
    .limit(1)
  if (!anyClientMessage?.length) return

  const { data: recentSameTextOtherChats } = await supabase
    .from('chat_messages')
    .select('chat_id')
    .eq('direction', 'out')
    .eq('text', input.text)
    .neq('chat_id', input.chatId)
    .gte('created_at', new Date(Date.now() - BULK_BROADCAST_DETECT_WINDOW_MS).toISOString())
    .limit(20)
  const distinctOtherChats = new Set((recentSameTextOtherChats ?? []).map((row) => row.chat_id as string)).size

  await supabase.from('chat_messages').upsert(
    {
      amo_message_id: `ga:${input.providerMessageId}`,
      chat_id: input.chatId,
      direction: 'out',
      sender: 'operator',
      author_name: isBulkBroadcast(distinctOtherChats) ? BULK_BROADCAST_AUTHOR_MARKER : input.authorName,
      text: input.text,
    },
    { onConflict: 'amo_message_id', ignoreDuplicates: true }
  )
}

const chatQueues = new Map<string, Promise<void>>()
// Живой баг: лимит был 4, потом 12 — и generateAndSendGreenApiReply (весь
// ответ, включая намеренную 10-секундную паузу перед первым «Здравствуйте»
// и паузы 0.9–1.4с между сообщениями внутри одного ответа) держит слот всё
// это время. Под наплывом клиентов (реклама, рассылка) даже 12 слотов
// становились очередью — по прямой просьбе владельца лимита больше нет:
// createLimiter(Infinity) технически сохраняет структуру кода (тот же
// вызов limit(fn) везде ниже), но runNext() в concurrency-limit.ts никогда
// не увидит active >= Infinity, так что задача стартует сразу же, без
// очереди — де-факто отвечает всем одновременно.
const globalGreenApiProcessingLimit = createLimiter(Infinity)

async function isManagerControllingChat(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string
): Promise<boolean> {
  const [lastOperatorResult, controlResult] = await Promise.all([
    // limit(20), не 1: часть последних «operator»-записей может быть
    // отмечена как массовая рассылка (BULK_BROADCAST_AUTHOR_MARKER) — её
    // пропускаем, ищем последнюю ПОХОЖУЮ НА РЕАЛЬНОГО человека.
    supabase
      .from('chat_messages')
      .select('created_at, author_name')
      .eq('chat_id', chatId)
      .eq('sender', 'operator')
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('chat_control')
      .select('bot_enabled, updated_at')
      .eq('chat_id', chatId)
      .maybeSingle(),
  ])
  const lastGenuineOperatorRow = (
    lastOperatorResult.data as { created_at: string; author_name: string | null }[] | null
  )?.find((row) => row.author_name !== BULK_BROADCAST_AUTHOR_MARKER)
  const lastOperatorAt = lastGenuineOperatorRow?.created_at
    ? new Date(lastGenuineOperatorRow.created_at).getTime()
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
    .from('chat_messages')
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
 * Клиент 5 минут не ответил на CITY_QUESTION (см. CITY_WAIT_ANCHOR_ID_PREFIX,
 * followup-scheduler.ts) — присылаем сам блок «до/после» без доставки и
 * голосового (город ещё не известен, их посчитать не из чего). Использует
 * тот же claimResultsBlock, что и обычный путь через ответ клиента — если
 * клиент потом всё же назовёт город, фото не задвоится (claim уже занят),
 * а доставка и голосовое всё равно уйдут отдельным независимым захватом
 * (claimOnce('results-delivery') в generateAndSendGreenApiReply).
 */
export async function sendResultsPhotoOnly(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string,
  opts: { dryRun?: boolean } = {}
): Promise<void> {
  if (!(await claimResultsBlock(supabase, chatId))) return
  const mediaBaseUrl = process.env.SMILEKIT_BOT_API_URL?.replace(/\/$/, '')
  if (!mediaBaseUrl) return
  const waChatId = `${chatId}@c.us`

  await supabase.from('chat_messages').upsert({
    amo_message_id: `ga:bot:city-timeout:${chatId}:results-intro`,
    chat_id: chatId,
    direction: 'out',
    sender: 'bot',
    text: RESULTS_INTRO,
  }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
  if (!opts.dryRun) {
    await sendGreenApiMessage(waChatId, RESULTS_INTRO).catch((error) =>
      console.error('greenapi bot-reply: city-timeout results intro failed', error)
    )
  }

  for (const [name, caption] of RESULT_PHOTOS) {
    const photoMessageId = `ga:bot:city-timeout:${chatId}:result:${name}`
    const { error: photoReserveError } = await supabase.from('chat_messages').upsert({
      amo_message_id: photoMessageId,
      chat_id: chatId,
      direction: 'out',
      sender: 'bot',
      text: caption || '[фото результата]',
    }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
    if (photoReserveError) {
      console.error('greenapi bot-reply: city-timeout photo reserve failed', photoReserveError.message)
      continue
    }
    if (!opts.dryRun) {
      try {
        await sendGreenApiFileByUrl({
          chatId: waChatId,
          urlFile: `${mediaBaseUrl}/media/results/${name}`,
          fileName: name,
          caption: caption || undefined,
        })
      } catch (error) {
        await supabase.from('chat_messages').delete().eq('amo_message_id', photoMessageId)
        console.error('greenapi bot-reply: city-timeout photo send failed', error)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
}

/**
 * Атомарный одноразовый захват по ключу — тот же UNIQUE(amo_message_id)
 * приём, что claimResultsBlock. Используется для лестницы скидок: первый
 * вызов с key='discount13' захватывает 13%, следующий с 'discount20' — 20%.
 */
async function claimOnce(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string,
  key: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('chat_messages')
    .upsert(
      {
        amo_message_id: `ga:claim:${key}:${chatId}`,
        chat_id: chatId,
        direction: 'out',
        sender: 'bot',
        text: `[claim:${key}]`,
      },
      { onConflict: 'amo_message_id', ignoreDuplicates: true }
    )
    .select('id')
  if (error) {
    console.error('greenapi bot-reply: claim failed', key, error.message)
    return false
  }
  return Boolean(data?.length)
}

/**
 * Скидка — только по лестнице, никогда сама по себе от ИИ: 13% на первую
 * просьбу, 20% на вторую, дальше — фиксированный отказ. Общее состояние с
 * followup-scheduler.ts (тот же claimOnce/ключи), чтобы прямой вопрос про
 * скидку и часовой дожим после 13% не спорили друг с другом за один и тот
 * же шаг лестницы.
 */
export async function nextDiscountOffer(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string
): Promise<string> {
  if (await claimOnce(supabase, chatId, 'discount13')) return DISCOUNT_OFFER_13_TEXT
  if (await claimOnce(supabase, chatId, 'discount20')) return DISCOUNT_OFFER_20_TEXT
  return DISCOUNT_REJECT_TEXT
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
  const [integrationResult, managerControls, handedOff] = await Promise.all([
    supabase.from('integrations').select('*').in('name', [...WHATSAPP_INTEGRATION_NAMES]).maybeSingle(),
    isManagerControllingChat(supabase, chatId),
    isHandedOffToManager(supabase, chatId),
  ])
  if (integrationResult.error) return false
  const integrationActive = opts.skipIntegrationCheck
    ? true
    : isIntegrationBotEnabled(integrationResult.data)
  return integrationActive && !managerControls && !handedOff
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
/**
 * Живой баг: пуш заказа в группу доставки (Telegram и/или WhatsApp) падал
 * на одиночном сетевом сбое без единой попытки повтора — клиент получал
 * «чек принят», а курьер о заказе просто не узнавал, ни в CRM, ни в логах
 * (только console.error, который никто не видит в реальном времени). Три
 * попытки с растущей паузой закрывают почти все временные сбои.
 */
async function withRetries<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
      }
    }
  }
  throw lastError
}

/** Сумма с чека — только то, что модель реально прочитала, без подстановки прайса. */
function receiptAmount(check: ReceiptCheck | null): number | null {
  const amount = check?.detected_amount_kgs
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : null
}

/**
 * Клиент прислал чек, а чат ведёт менеджер. Бот здесь молчит, но продажа
 * должна попасть в CRM: раньше ветка чека стояла после проверки «менеджер
 * ведёт чат» и до неё не доходила — продажи менеджеров не записывались вовсе
 * (в сентябре 5 заказов на тысячи лидов), и аналитика конверсии была пустой.
 * Клиенту ничего не отвечаем и в группу доставки не шлём — это делает
 * менеджер. Заказ заводим, только если проверка уверенно видит скриншот оплаты.
 */
async function recordReceiptFromManagedChat(
  supabase: ReturnType<typeof createAdminClient>,
  input: InboundGreenApiMessage,
  externalKey: string
): Promise<void> {
  let check: ReceiptCheck | null = null
  try {
    check = await verifyGreenApiReceipt(input.mediaUrl!, await receiptReferenceDate(supabase, input.chatId))
  } catch (error) {
    console.error('greenapi bot-reply: managed-chat receipt verification failed', error)
    return
  }
  if (!check?.is_real_receipt_screenshot) return

  const orderKey = `${externalKey}:order:${input.providerMessageId}`
  const result = await ingestOrder({
    externalKey: orderKey,
    source: 'manual',
    customerName: input.authorName,
    customerPhone: input.chatId,
    quantity: null,
    totalAmount: receiptAmount(check),
    currency: 'KGS',
    summary: `Чек об оплате, чат вёл менеджер (WhatsApp)${input.text ? `\n${input.text}` : ''}\n[media]${input.mediaUrl}`,
  })
  if (result.error) {
    console.error('greenapi bot-reply: managed-chat order ingest failed', result.error)
    return
  }
  const { data: dealRow } = await supabase.from('deals').select('id').eq('external_key', externalKey).maybeSingle()
  const dealId = (dealRow as { id?: string } | null)?.id
  if (dealId && result.id) await supabase.from('orders').update({ deal_id: dealId }).eq('id', result.id)
}

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
  // Автопроверка отработала и уверенно говорит «это не скриншот оплаты»
  // (например, фото зубов, а не чек) — не заказ и не «чек не прошёл
  // проверку», а вообще другая картинка. Заказ на такое заводить не нужно.
  const notAReceipt = check?.is_real_receipt_screenshot === false && checkUnavailable
  const reply = verified ? RECEIPT_ACCEPTED : notAReceipt ? RECEIPT_NOT_A_RECEIPT : RECEIPT_REJECTED

  if (!(await canSendGreenApiBotReply(supabase, input.chatId))) return
  const botMessageId = `ga:bot:${input.providerMessageId}:receipt`
  await supabase.from('chat_messages').upsert({
    amo_message_id: botMessageId,
    chat_id: input.chatId,
    direction: 'out',
    sender: 'bot',
    text: reply,
  }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
  try {
    await sendGreenApiMessage(`${input.chatId}@c.us`, reply)
  } catch (error) {
    await supabase.from('chat_messages').delete().eq('amo_message_id', botMessageId)
    console.error('greenapi bot-reply: receipt reply failed', error)
    return
  }

  // Не чек — отвечаем и молча выходим: не заводим заказ, не шлём в группу
  // доставки, не двигаем сделку на этап «заказ». Ниже — только реальные чеки
  // (принятые и требующие ручной проверки).
  if (notAReceipt) return

  // Адрес клиент обычно пишет подписью к чеку или соседним сообщением —
  // берём последние свои сообщения, чтобы менеджеру в группе не пришлось
  // лезть в переписку.
  const { data: recent } = await supabase
    .from('chat_messages')
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
    totalAmount: receiptAmount(check),
    currency: 'KGS',
    summary:
      `${verified ? 'Чек проверен' : checkUnavailable ? 'Чек не проверен автоматически' : 'Чек не прошёл проверку'} (WhatsApp)` +
      (input.text ? `\nАдрес: ${input.text}` : '') +
      `\n[media]${input.mediaUrl}`,
  }).then((result) => {
    if (result.error) console.error('greenapi bot-reply: order ingest failed', result.error)
  })
  await markOrderPlaced(supabase, input.chatId)
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
    await withRetries(async () => {
      const bytes = await fetch(input.mediaUrl!, { signal: AbortSignal.timeout(20_000) })
        .then((response) => response.arrayBuffer())
      const pushed = await smilekitBotFetch('/internal/push_delivery', {
        method: 'POST',
        body: {
          imageBase64: Buffer.from(bytes).toString('base64'),
          kind: 'image',
          source: 'WhatsApp',
          externalKey: `${externalKey}:order:${input.providerMessageId}`,
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
      if (!pushed.ok) throw new Error(pushed.error ?? 'push_delivery failed')
    })
  } catch (error) {
    console.error('greenapi bot-reply: delivery push failed after retries', error)
  }

  const botConfig = await getWhatsappBotConfig()
  if (botConfig.deliveryGroupId) {
    // Живой баг: курьер в группе доставки не видел, оплачен ли заказ уже
    // (чек проверен автоматически) — рисковал попросить оплату повторно
    // при вручении или, наоборот, отдать заказ с непрошедшим проверку чеком.
    // Тот же статус, что уже пишем в summary заказа (см. ingestOrder выше).
    const paymentLine = verified
      ? 'Оплата: чек проверен автоматически ✅ — повторно не спрашивать'
      : checkUnavailable
        ? 'Оплата: автопроверка недоступна — проверьте чек глазами перед выдачей'
        : 'Оплата: чек НЕ прошёл проверку ⚠️ — уточните у клиента перед выдачей'
    // Промпт из настроек — свободный текст, {name}/{phone}/{address}/{payment}
    // заменяются значениями заказа. Без промпта — тот же формат, что уходит
    // в Telegram, плюс строка оплаты в конце.
    const caption = (botConfig.deliveryPrompt || 'Новый заказ ({name}, {phone})\nАдрес: {address}\n{payment}')
      .replaceAll('{name}', input.authorName || '—')
      .replaceAll('{phone}', input.chatId)
      .replaceAll('{address}', input.text || '—')
      .replaceAll('{payment}', paymentLine)
    const fullCaption = caption.includes(paymentLine) ? caption : `${caption}\n${paymentLine}`
    try {
      await withRetries(() => sendGreenApiDeliveryGroupFile(botConfig.deliveryGroupId, {
        urlFile: input.mediaUrl!,
        fileName: 'receipt.jpg',
        caption: fullCaption,
      }))
    } catch (error) {
      console.error('greenapi bot-reply: whatsapp delivery group push failed after retries', error)
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

const COD_ORDER_CONFIRM_REPLY = 'Спасибо! 😊 Заказ оформлен, оплата — при получении. Скоро свяжется курьер.'

/**
 * Клиент попросил оплату при получении (см. PAY_ON_DELIVERY_REQUEST) и
 * прислал следующим сообщением адрес+телефон — регистрируем заказ и шлём
 * в группу доставки текстом, без чека/QR (по определению для COD их нет).
 * true — сообщение обработано как адрес и общий скрипт ниже уже не нужен.
 */
async function handleCodAddressSubmission(
  supabase: ReturnType<typeof createAdminClient>,
  input: InboundGreenApiMessage,
  externalKey: string,
  opts: GreenApiTestOptions
): Promise<boolean> {
  // Живой баг: якорь искался как «последняя запись перед этим сообщением»,
  // а любое следующее сообщение клиента засчитывалось за адрес без проверки
  // содержимого — клиент написал «Хорошо подумаю» (просто отложил ответ,
  // никакого адреса), бот всё равно завёл заказ и отчитался «заказ
  // оформлен, курьер свяжется». Теперь якорь ищем по chatId напрямую (тот
  // же приём, что PROMISED_ANCHOR_ID_PREFIX) — так его не «погребает» ответ
  // бота на промежуточную отговорку клиента.
  const { data: anchorRow } = await supabase
    .from('chat_messages')
    .select('id')
    .eq('amo_message_id', `${COD_WAIT_ANCHOR_ID_PREFIX}:${input.chatId}`)
    .maybeSingle()
  if (!anchorRow) return false
  // Тот же блок-лист общих реплик (спасибо/хорошо/подумаю/потом и т.п.),
  // что и NOT_A_LOCATION_REPLY — если клиент явно не назвал ничего
  // конкретного, продолжаем ждать реальный адрес, а не выдумываем заказ
  // из вежливой отговорки. Якорь остаётся как есть — он больше не
  // привязан к позиции в истории, следующее сообщение найдёт его снова.
  if (NOT_A_LOCATION_REPLY.test(input.text.trim().toLowerCase().replace(/\s+/g, ' '))) return false
  if (!(await canSendGreenApiBotReply(supabase, input.chatId, opts))) return false

  const botMessageId = `ga:bot:${input.providerMessageId}:cod-confirm`
  const { data: reserved } = await supabase.from('chat_messages').upsert({
    amo_message_id: botMessageId,
    chat_id: input.chatId,
    direction: 'out',
    sender: 'bot',
    text: COD_ORDER_CONFIRM_REPLY,
  }, { onConflict: 'amo_message_id', ignoreDuplicates: true }).select('id')
  if (!reserved?.length) return true // дубль вебхука — уже обработано
  // Закрываем ожидание — иначе следующее сообщение клиента (уже после
  // оформления) снова нашло бы этот якорь и было бы принято за ещё один
  // адрес.
  await supabase.from('chat_messages').delete().eq('amo_message_id', `${COD_WAIT_ANCHOR_ID_PREFIX}:${input.chatId}`)

  if (!opts.dryRun) {
    try {
      await sendGreenApiMessage(`${input.chatId}@c.us`, COD_ORDER_CONFIRM_REPLY)
    } catch (error) {
      await supabase.from('chat_messages').delete().eq('amo_message_id', botMessageId)
      console.error('greenapi bot-reply: cod confirm reply failed', error)
      return true
    }

    const advanced = await advanceDealFromBotAction(externalKey, 'order')
    if (!advanced.ok && advanced.error) {
      console.error('greenapi bot-reply: cod stage advance failed', advanced.error)
    }
    await ingestOrder({
      externalKey: `${externalKey}:order:${input.providerMessageId}`,
      source: 'manual',
      customerName: input.authorName,
      customerPhone: input.chatId,
      quantity: 1,
      totalAmount: null,
      currency: 'KGS',
      summary: `Оплата при получении (WhatsApp)\nАдрес/телефон от клиента: ${input.text}`,
    }).then((result) => {
      if (result.error) console.error('greenapi bot-reply: cod order ingest failed', result.error)
    })
    await markOrderPlaced(supabase, input.chatId)

    const botConfig = await getWhatsappBotConfig()
    if (botConfig.deliveryGroupId) {
      const groupText =
        'Новый заказ — оплата при получении 💵\n' +
        `Телефон: ${input.chatId}\n` +
        `Имя: ${input.authorName || '—'}\n` +
        `Адрес/телефон от клиента: ${input.text}`
      try {
        await withRetries(() => sendGreenApiDeliveryGroup(botConfig.deliveryGroupId, groupText))
      } catch (error) {
        console.error('greenapi bot-reply: cod delivery group push failed after retries', error)
      }
    }
  }
  return true
}

/**
 * Завести лид по входящему — отдельно от остального скрипта.
 *
 * Требование: в CRM должно попадать КАЖДОЕ обращение, независимо от того,
 * ответил ли бот. Поэтому создание лида не должно зависеть ни от расшифровки
 * голосового, ни от успешной записи сообщения, ни от того, включён ли бот.
 */
async function createLeadFromInbound(
  input: InboundGreenApiMessage,
  opts: GreenApiTestOptions
): Promise<void> {
  // Лаборатория не должна плодить настоящие лиды в воронке.
  if (opts.dryRun) return
  try {
    const supabase = createAdminClient()
    const externalKey = await resolveGreenApiExternalKey(supabase, input.chatId)
    if (!externalKey.startsWith('greenapi:')) return
    await upsertDealFromInbound({
      externalKey,
      source: 'whatsapp',
      customerName: input.authorName,
      customerPhone: input.chatId,
    })
  } catch (error) {
    console.error('greenapi bot-reply: lead upsert failed', input.chatId, error)
  }
}

async function processInboundGreenApiMessageNow(
  input: InboundGreenApiMessage,
  opts: GreenApiTestOptions = {}
): Promise<void> {
  const supabase = createAdminClient()

  // Расшифровка голосового — УЛУЧШЕНИЕ ответа, а не условие приёма лида.
  //
  // Живая потеря данных: раньше оба сбоя расшифровки делали return ДО
  // сохранения сообщения и создания сделки. Клиент, приславший голосовое,
  // не попадал в CRM вообще — ни переписки, ни лида, — и менеджер о нём
  // никогда не узнавал. В проде это срабатывало днями подряд (в логах
  // «voice transcription failed»).
  //
  // Теперь при сбое мы продолжаем: сообщение и лид сохраняются с пометкой,
  // что это нерасшифрованное голосовое, а от автоответа бот воздержится —
  // отвечать на неизвестный текст он не должен.
  let transcript: string | null = null
  let voiceUnreadable = false
  try {
    transcript = await transcribeGreenApiVoice(input)
  } catch (error) {
    console.error('greenapi bot-reply: voice download/transcription threw', input.providerMessageId, error)
  }
  if (VOICE_TYPES.has(input.messageType ?? '') && !transcript) {
    console.error('greenapi bot-reply: voice transcription failed', input.providerMessageId)
    voiceUnreadable = true
  }
  if (transcript) input = { ...input, text: transcript }
  if (voiceUnreadable) {
    input = { ...input, text: input.text?.trim() || VOICE_UNREADABLE_PLACEHOLDER }
  }

  const { data: inserted, error: insertError } = await supabase
    .from('chat_messages')
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
    // Сообщение не сохранилось — но лид всё равно должен появиться в CRM,
    // иначе обращение пропадёт бесследно (так и вышло 14.09, когда имя
    // таблицы разошлось с базой). Дальше по скрипту не идём: без истории
    // бот отвечать не должен.
    console.error('greenapi bot-reply: insert failed', insertError.message)
    await createLeadFromInbound(input, opts)
    return
  }
  if (!inserted?.length) return // дубль вебхука — уже обработано

  // Клиент сам назвал срок («завтра», «через час») — не дёргаем его
  // дожимом раньше. Ключ фиксированный (без providerMessageId) — строка
  // перезаписывается upsert-ом (onConflict без ignoreDuplicates) при каждом
  // новом обещании, а не копится по одной на сообщение.
  const promisedHours = promisedDelayHours(input.text)
  if (promisedHours !== null) {
    const promisedUntilMs = Date.now() + promisedHours * 3600_000
    await supabase.from('chat_messages').upsert({
      amo_message_id: `${PROMISED_ANCHOR_ID_PREFIX}:${input.chatId}`,
      chat_id: input.chatId,
      direction: 'out',
      sender: 'bot',
      text: `[обещал вернуться до ${new Date(promisedUntilMs).toISOString()}]`,
    }, { onConflict: 'amo_message_id' })
  }

  const externalKey = await resolveGreenApiExternalKey(supabase, input.chatId)
  const { data: integration } = await supabase
    .from('integrations')
    .select('*')
    .in('name', [...WHATSAPP_INTEGRATION_NAMES])
    .maybeSingle()
  const botEnabled = opts.skipIntegrationCheck
    ? true
    : isIntegrationBotEnabled(integration)

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

  // Голосовое не расшифровалось: лид и сообщение уже сохранены выше, но
  // отвечать боту нечего — текста он не знает. По скрипту не идём (ответил
  // бы невпопад), передаём человеку. Это тот самый случай «бот не уверен»,
  // для которого и предусмотрена передача менеджеру.
  if (voiceUnreadable) {
    if (!opts.dryRun) await handOffToManager(supabase, input)
    return
  }

  if (await isManagerControllingChat(supabase, input.chatId)) {
    if (!opts.dryRun && IMAGE_TYPES.has(input.messageType ?? '') && input.mediaUrl) {
      await recordReceiptFromManagedChat(supabase, input, externalKey)
    }
    return
  }
  if (await isPhoneBlockedForBot(supabase, input.chatId)) return
  if (await maybeRemindHandoff(supabase, input)) return

  // Живой баг-правка: раньше после блока результата (фото до/после +
  // голосовое) шла автоматическая цепочка дожима (CTA → «актуально?» →
  // скидки), и передача менеджеру срабатывала только на ответ ИМЕННО на
  // один из её пяти текстов. По прямой просьбе владельца цепочку убрали
  // целиком — бот после блока результата больше не пишет вообще ничего
  // сам, а на любое следующее сообщение клиента сразу передаёт менеджеру.
  // Якорь POST_RESULTS_STAGE_ANCHOR_ID_PREFIX ставится один раз сразу
  // после блока результата (см. ниже) и снимается либо тут (первым же
  // ответом клиента), либо handOffToManager-ом.
  if (await isAwaitingPostResultsReply(supabase, input.chatId)) {
    await handOffToManager(supabase, input)
    return
  }

  // Картинка от клиента — это чек. Отдельная ветка до общего скрипта: ИИ
  // картинку не видит и, не зная об оплате, предлагал предоплату уже
  // оплатившему клиенту.
  if (botEnabled && IMAGE_TYPES.has(input.messageType ?? '') && input.mediaUrl) {
    await handleGreenApiReceipt(supabase, input, externalKey)
    return
  }

  // Клиент попросил оплату при получении (см. PAY_ON_DELIVERY_REQUEST) и
  // прислал следующим сообщением адрес+телефон — до общего скрипта.
  if (botEnabled && input.text && (await handleCodAddressSubmission(supabase, input, externalKey, opts))) {
    return
  }

  // Странный вопрос (документы/лицензия/регистрация) — бот молчит
  // полностью, дальше диалог ведёт менеджер. Ранний выход до генерации
  // ответа: скрипт и ИИ сюда не доходят вовсе.
  if (SUSPICIOUS_QUESTION.test(input.text)) {
    if (!opts.dryRun) {
      const advanced = await advanceDealFromBotAction(externalKey, 'non_standard_request')
      if (!advanced.ok && advanced.error) {
        console.error('greenapi bot-reply: stage advance failed', 'non_standard_request', advanced.error)
      }
    }
    return
  }

  // Заказ уже оформлен — вопрос про доставку/курьера бот больше не
  // обрабатывает сам (реальный статус знает только курьер/менеджер), молчим
  // и оставляем ответ человеку. Остальные вопросы бот продолжает вести как
  // обычно (см. ORDER_PLACED_ANCHOR_ID_PREFIX выше).
  if (POST_ORDER_DELIVERY_QUESTION.test(input.text) && (await hasPlacedOrder(supabase, input.chatId))) {
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

  await scheduleGreenApiReply(input, opts)
}

const DEBOUNCE_MS = 8_000

interface PendingGreenApiReplyBatch {
  texts: string[]
  timer: ReturnType<typeof setTimeout>
}

// Клиент часто пишет несколько сообщений подряд отдельными пузырями
// («Здравствуйте» → «Бишкек» → «сколько стоит») — без буфера бот отвечал на
// каждое сразу и вразнобой, вместо одного связного ответа. Ждём тишины после
// последнего сообщения и отвечаем на все разом. В «Лаборатории» (dryRun)
// ждать не нужно — там тестируют по одному сообщению за раз и ждут ответ
// сразу.
// Живой баг: было 50 секунд — клиент реально ждал почти минуту на простое
// «Здравствуйте» и жаловался, что бот «долго отвечает». 8 секунд всё ещё
// хватает поймать быстрые подряд идущие сообщения, но не выглядит как
// зависание.
const pendingGreenApiReplyBatches = new Map<string, PendingGreenApiReplyBatch>()

function scheduleGreenApiReply(input: InboundGreenApiMessage, opts: GreenApiTestOptions): Promise<void> | void {
  if (opts.dryRun) {
    // Живой баг: раньше это тоже был fire-and-forget (void ...) — вызывающий
    // код («Лаборатория», см. sendWhatsappLabMessage) читал историю чата
    // сразу после отправки и почти всегда успевал раньше, чем ответ бота
    // дописывался в БД, поэтому бот «не отвечал». Возвращаем промис, чтобы
    // dryRun-вызов реально дожидался готового ответа — ровно то, что и
    // задумано комментарием ниже про debounce.
    return globalGreenApiProcessingLimit(() => generateAndSendGreenApiReply(input, 1, opts))
  }
  const existing = pendingGreenApiReplyBatches.get(input.chatId)
  if (existing) clearTimeout(existing.timer)
  const texts = existing ? [...existing.texts, input.text] : [input.text]
  const timer = setTimeout(() => {
    pendingGreenApiReplyBatches.delete(input.chatId)
    const batchInput: InboundGreenApiMessage = { ...input, text: texts.join('\n') }
    void globalGreenApiProcessingLimit(() => generateAndSendGreenApiReply(batchInput, texts.length, opts)).catch(
      (error) => console.error('greenapi bot-reply: debounced reply failed', error)
    )
  }, DEBOUNCE_MS)
  pendingGreenApiReplyBatches.set(input.chatId, { texts, timer })
}

async function generateAndSendGreenApiReply(
  input: InboundGreenApiMessage,
  batchSize: number,
  opts: GreenApiTestOptions
): Promise<void> {
  const supabase = createAdminClient()
  const externalKey = await resolveGreenApiExternalKey(supabase, input.chatId)

  const { data: rows } = await supabase
    .from('chat_messages')
    .select('sender, text, id, amo_message_id')
    .eq('chat_id', input.chatId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(31)
  const history = (rows ?? [])
    .reverse()
    .slice(0, -batchSize)
    // ga:claim:* — служебные защёлки и якорь follow-up, клиент их не видел:
    // в истории для ИИ и в «последнем сообщении бота» им не место (иначе
    // после блока результата последним сообщением бота считался бы якорь,
    // и «давайте» клиента не опознавалось как согласие оформить).
    .filter((row) => !String((row as { amo_message_id: string }).amo_message_id).startsWith('ga:claim:'))
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
  let needsCityAnchor = false
  let needsCodAnchor = false
  let sendResultsPhotoThisTurn = false
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
  // Живой баг: раньше claimResultsBlock/claimOnce('results-delivery')
  // вызывались здесь безусловно, ДО того, как известно, какая именно ветка
  // ниже сработает — короткое «давайте оформим» без названного города
  // ошибочно проходило shouldSendResultsAfterLocation (короткий ответ без
  // «?» после вопроса про город), claim «съедался» впустую, а фото «до/после»
  // всё равно уходило следом за чек-листом заказа, хотя город не называли.
  // Теперь оба захвата — внутри самой ветки доставки ниже, только когда она
  // реально выбрана (после ORDER_INTENT и остальных более специфичных веток).
  const wantsResultsBlock = looksLikeLocationAnswer || Boolean(deliveryTemplate && priceKnown)

  const lastBotMessage = [...history].reverse().find((item) => item.role === 'assistant')?.content ?? ''

  // Тексты, редактируемые из CRM («Настройки бота» → «Шаблоны») — пустая
  // строка в настройках означает «не переопределено», используем дефолт.
  const botConfig = await getWhatsappBotConfig()
  const T = {
    productInfo: botConfig.templates.productInfo || PRODUCT_INFO,
    orderChecklist: botConfig.templates.orderChecklist || pickVariant(ORDER_CHECKLIST_VARIANTS),
    doubtResult: botConfig.templates.doubtResult || DOUBT_RESULT_REPLY,
    firstUseEffect: botConfig.templates.firstUseEffect || FIRST_USE_EFFECT,
    lowStockCta: botConfig.templates.lowStockCta || LOW_STOCK_DISCOUNT_CTA,
    complaintPrompt: botConfig.templates.complaintPrompt || pickVariant(COMPLAINT_PROMPT_VARIANTS),
    cooperationReply: botConfig.templates.cooperationReply || pickVariant(COOPERATION_REPLY_VARIANTS),
  }

  // Согласие оформить: строгое «да/давайте» после любого вопроса-CTA, либо
  // мягкое (см. isLooseAffirmative) после CTA или сразу после блока
  // результата — голосовые «эффект с первого раза» и «состав безопасный» и
  // есть подводка к заказу, «хочу»/«давайте» на них — согласие, а не тема
  // для ИИ. Живой баг: после добавления второго голосового в конец блока
  // (RESULTS_BLOCK_SAFETY_TEXT) последним сообщением бота стало уже не
  // firstUseEffect — без явной проверки на новый текст тоже это согласие
  // клиента снова уходило бы в ИИ вместо чек-листа.
  const afterOrderPrompt =
    ORDER_CTA_MARKER.test(lastBotMessage) ||
    lastBotMessage === T.firstUseEffect ||
    lastBotMessage === RESULTS_BLOCK_SAFETY_TEXT
  const acceptedOrderCta =
    afterOrderPrompt && (AFFIRMATIVE_ONLY.test(input.text) || isLooseAffirmative(input.text))

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
    needsCityAnchor = true
  } else if (isKyrgyz && KYRGYZ_PRICE_INTENT.test(input.text)) {
    replies.push(KYRGYZ_PRODUCT_INFO)
  } else if (SCAM_DOUBT.test(input.text)) {
    replies.push(T.doubtResult)
    voiceReplies.add(T.doubtResult)
  } else if (SAFETY_COMPOSITION_DOUBT.test(input.text)) {
    const variant = pickVariant(SAFETY_COMPOSITION_VARIANTS)
    replies.push(variant)
    if (SAFETY_COMPOSITION_HARM_DOUBT.test(input.text)) voiceReplies.add(variant)
  } else if (EFFECT_DURATION_QUESTION.test(input.text)) {
    replies.push(pickVariant(EFFECT_DURATION_VARIANTS))
  } else if (UNSUPPORTED_COUNTRY.test(input.text)) {
    replies.push(UNSUPPORTED_COUNTRY_REPLY)
  } else if (DELIVERY_FREE_QUESTION.test(input.text)) {
    replies.push(DELIVERY_FREE_DISCOUNT_REPLY)
  } else if (PICKUP_QUESTION.test(input.text)) {
    replies.push(PICKUP_REPLY)
  } else if (ADDRESS_QUESTION.test(input.text)) {
    replies.push(ADDRESS_QUESTION_REPLY)
  } else if (DELIVERY_COST_QUESTION.test(input.text)) {
    const cityTemplate = deliveryTemplateForCity(input.text) ?? deliveryTemplateForCity(historyText)
    if (cityTemplate) {
      const isBishkekOrTokmok = /бишке|токмо/.test(input.text.replace(/щ/g, 'ш')) || /бишке|токмо/.test(historyText)
      replies.push(cityTemplate, isBishkekOrTokmok ? DELIVERY_PAYMENT_BISHKEK : DELIVERY_PAYMENT_REGIONS)
      if (isBishkekOrTokmok) voiceReplies.add(DELIVERY_PAYMENT_BISHKEK)
    } else {
      replies.push(CITY_QUESTION)
      needsCityAnchor = true
    }
  } else if (COMPLAINT.test(input.text)) {
    replies.push(T.complaintPrompt)
  } else if (COOPERATION.test(input.text)) {
    replies.push(T.cooperationReply)
  } else if (DISCOUNT_REQUEST.test(input.text)) {
    // Прямая просьба о скидке — сразу лестница 13%→20%, а не пересказ цены
    // или доставки не по теме (живой баг: спросили скидку, бот втирал про
    // доставку).
    replies.push(await nextDiscountOffer(supabase, input.chatId))
  } else if (NEGATIVE_ONLY.test(input.text) && ORDER_CTA_VARIANTS.includes(lastBotMessage)) {
    // Клиент отказался оформлять на CTA «вам оформить доставку?» — та же
    // лестница скидок, что и на прямую просьбу выше, общее состояние.
    replies.push(await nextDiscountOffer(supabase, input.chatId))
  } else if (PAY_ON_DELIVERY_REQUEST.test(input.text)) {
    // Клиент прямо попросил оплату при получении — ORDER_INTENT ниже тоже
    // совпал бы (в тексте есть «оплатить»), но чек-лист с QR требовал бы
    // предоплату вопреки прямой просьбе клиента. Адрес+телефон вместо чека —
    // ждём следующим сообщением (см. COD_WAIT_ANCHOR_ID_PREFIX ниже).
    replies.push(PAY_ON_DELIVERY_ACK_REPLY)
    needsCodAnchor = true
  } else if (!FUTURE_ORDER_QUESTION.test(input.text) && (ORDER_INTENT.test(input.text) || acceptedOrderCta)) {
    // QR отправляется сразу вместе с чек-листом (ниже, sendPaymentQr) — раньше
    // WhatsApp не умел слать картинки, поэтому клиента отправляли к менеджеру
    // за реквизитами. Green API картинки шлёт, так что ждать «подтверждения»
    // перед выдачей реквизитов больше не нужно.
    // Живой баг: чек-лист уходил голосовым, а следом за QR — ещё одно
    // голосовое (qr_payment_note.ogg) — клиент получал подряд два голосовых
    // сообщения. Список из трёх пунктов проще читать текстом (можно
    // вернуться и свериться), голосовое оставляем только одно — после QR.
    replies.push(T.orderChecklist)
    sendPaymentQr = true
    stageAction = 'order'
  } else if (history.length === 0) {
    // Живой баг: раньше эта ветка стояла ПЕРЕД всеми проверками конкретного
    // намерения (жалоба/состав/скидка/сотрудничество/мошенники и т.д.) —
    // первое сообщение клиента получало этот шаблон, даже если в нём был
    // прямой вопрос или жалоба. Теперь это последний общий вариант — только
    // если ни одно специфичное намерение выше не совпало.
    replies.push(T.productInfo, CITY_QUESTION)
    needsCityAnchor = true
  } else if (deliveryTemplate && priceKnown && wantsResultsBlock) {
    // Доставка -> фото (в цикле отправки ниже) -> голосовое. Живой баг: оба
    // захвата (claimOnce/claimResultsBlock) раньше выполнялись безусловно
    // ДО выбора ветки — короткое «давайте оформим» без города ложно
    // проходило shouldSendResultsAfterLocation, «съедало» claim и следом за
    // чек-листом заказа (ветка ORDER_INTENT выше) улетало ещё и фото
    // «до/после», хотя город не называли. Теперь захват — только здесь, и
    // только когда эта ветка реально выбрана (после ORDER_INTENT и прочих).
    if (await claimOnce(supabase, input.chatId, 'results-delivery')) {
      replies.push(deliveryTemplate, T.firstUseEffect)
      voiceReplies.add(T.firstUseEffect)
      if (await claimResultsBlock(supabase, input.chatId)) {
        sendResultsPhotoThisTurn = true
        // По просьбе владельца (29.08): после блока результата бот больше
        // сам ничего не пишет — ни CTA, ни дожима. Этот якорь только
        // помечает «жду первый ответ клиента» — как только он придёт,
        // isAwaitingPostResultsReply увидит якорь и сразу передаст чат
        // менеджеру (handOffToManager), без всякой автоматики между этим
        // моментом и ответом клиента. followup-scheduler.ts эту стадию не
        // трогает вообще (processPostResultsFollowupStage убран).
        await supabase.from('chat_messages').upsert({
          amo_message_id: `${POST_RESULTS_STAGE_ANCHOR_ID_PREFIX}:${input.chatId}`,
          chat_id: input.chatId,
          direction: 'out',
          sender: 'bot',
          text: '[ожидание ответа после результата]',
        }, { onConflict: 'amo_message_id' })
      }
    }
  }

  if (replies.length === 0) {
    const labMessage = isKyrgyz
      ? `${input.text}\n\nЖоопту толугу менен кыргыз тилинде бер. Орусча сөздөрдү аралаштырба.`
      : input.text
    // Живой баг: клиент спросил «А какой адрес?», вызов ИИ-фолбэка
    // отвалился, и код тихо «return» — клиент не получил вообще ничего и
    // ждал ответа 6 часов, пока не написал то же самое ещё раз. Один повтор
    // при сбое плюс честный текстовый фолбэк вместо полной тишины, если и
    // повтор не помог — клиент видит хоть что-то, а не подвисший чат.
    let lab = await smilekitBotFetch<{ reply: string }>('/internal/lab', {
      method: 'POST',
      body: { message: labMessage, history },
      timeoutMs: BOT_TIMEOUTS_MS.lab,
    })
    // Повторяем только если бот недоступен. На таймауте повтор вреден: бот
    // ещё генерирует первый ответ, и второй запрос запустил бы вторую
    // генерацию поверх — вдвое больше нагрузки на ту же медленную нейросеть.
    if (!lab.ok && lab.status !== 504) {
      console.error('greenapi bot-reply: lab failed, retrying once', lab.error)
      lab = await smilekitBotFetch<{ reply: string }>('/internal/lab', {
        method: 'POST',
        body: { message: labMessage, history },
        timeoutMs: BOT_TIMEOUTS_MS.lab,
      })
    }
    if (!lab.ok) {
      console.error('greenapi bot-reply: lab failed after retry', lab.error)
      replies.push(FALLBACK_AI_FAILURE_REPLY)
    }
    const reply = lab.ok ? lab.data.reply?.trim() : undefined
    if (lab.ok && !reply) return
    if (reply) {
      replies.push(
        ...reply
          .split(/<NEXT_MESSAGE>/i)
          .map((part) => part.trim())
          .filter(Boolean)
      )
      if (replies.length === 0) return
      // Живой баг: ИИ сам «оформлял заказ» — сочинял свой чек-лист (просил
      // адрес/чек/реквизиты в произвольной форме) без QR, хотя на это есть
      // утверждённый шаблон. Если модель явно перешла к оформлению — шлём
      // шаблон и QR вместо её текста.
      if (replies.some((part) => AI_IMPROVISED_CHECKLIST.test(part))) {
        replies.length = 0
        replies.push(T.orderChecklist)
        sendPaymentQr = true
        stageAction = 'order'
      } else if (
        !DISCOUNT_REQUEST.test(input.text) &&
        !historyText.includes('сом') &&
        replies.some((part) => AI_IMPROVISED_DISCOUNT.test(part))
      ) {
        replies.length = 0
        replies.push(T.productInfo, CITY_QUESTION)
        needsCityAnchor = true
      }
    }
  }

  const chatId = `${input.chatId}@c.us`
  const mediaBaseUrl = process.env.SMILEKIT_BOT_API_URL?.replace(/\/$/, '')

  // Живой баг: самое первое «Здравствуйте» уходило мгновенно — читалось как
  // автоответчик, а не как человек. 10 секунд — та же пауза, что делает
  // менеджер, прежде чем открыть чат и начать печатать.
  if (replies[0] === T.productInfo) {
    await new Promise((resolve) => setTimeout(resolve, 10_000))
  }

  for (let index = 0; index < replies.length; index++) {
    if (!(await canSendGreenApiBotReply(supabase, input.chatId, opts))) return
    const text = replies[index]
    const botMessageId = `bot:${input.providerMessageId}:${index}`
    const { error: reserveError } = await supabase.from('chat_messages').upsert({
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
      const voiceName =
        text === T.firstUseEffect ? 'first_use_effect.ogg'
        : text === T.orderChecklist ? 'order_checklist.ogg'
        : text === RESULTS_BLOCK_SAFETY_TEXT ? 'composition_safe.ogg'
        : text === DELIVERY_PAYMENT_BISHKEK ? 'delivery_price_bishkek.ogg'
        : SAFETY_COMPOSITION_VARIANTS.includes(text) ? 'not_harmful.ogg'
        : 'not_scam.ogg'
      if (opts.dryRun) {
        // Тестовый chat_id не существует в WhatsApp — реальный вызов Green
        // API только тратил бы время и падал. Запись в chat_messages выше
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
      await supabase.from('chat_messages').delete().eq('amo_message_id', `ga:${botMessageId}`)
      console.error('greenapi bot-reply: send failed', error)
      return
    }
    // QR оплаты — сразу за чек-листом, до всего остального: клиент попросил
    // оформить и должен получить реквизиты в том же сообщении-связке, а не
    // после отдельного «подтверждения».
    if (sendPaymentQr && index === 0 && mediaBaseUrl) {
      const qrMessageId = `ga:bot:${input.providerMessageId}:qr`
      const { error: qrReserveError } = await supabase.from('chat_messages').upsert({
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
          await supabase.from('chat_messages').delete().eq('amo_message_id', qrMessageId)
          console.error('greenapi bot-reply: qr send failed', error)
        }
      }
      // Голосовое сразу после QR — пояснение по оплате поверх картинки с кодом.
      const qrVoiceMessageId = `ga:bot:${input.providerMessageId}:qr-voice`
      const { error: qrVoiceReserveError } = await supabase.from('chat_messages').upsert({
        amo_message_id: qrVoiceMessageId,
        chat_id: input.chatId,
        direction: 'out',
        sender: 'bot',
        text: '[голосовое: пояснение по оплате]',
      }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
      if (!qrVoiceReserveError && !opts.dryRun) {
        try {
          await sendGreenApiVoice(chatId, `${mediaBaseUrl}/media/voice/qr_payment_note.ogg`, 'qr_payment_note.ogg')
        } catch (error) {
          await supabase.from('chat_messages').delete().eq('amo_message_id', qrVoiceMessageId)
          console.error('greenapi bot-reply: qr voice send failed', error)
        }
      }
    }
    // Фото результатов — сразу после первой реплики, как в Telegram
    // (__main__.py: подводка -> send_media_group -> голосовое -> CTA).
    // Ровно один раз за чат: shouldSendResultsAfterLocation срабатывает на
    // каждый короткий ответ клиента, и без этой защиты бот присылал фото
    // снова и снова. В Telegram ту же роль играет storage.claim_event.
    if (sendResultsPhotoThisTurn && index === 0 && mediaBaseUrl) {
      // Запись бота ДО отправки обязательна для любого исходящего: эхо из
      // вебхука Green API ищет свежую строку sender='bot' с тем же текстом,
      // и без неё подводка опозналась бы как сообщение менеджера — бот
      // замолкал в чате прямо посреди отправки фото.
      await supabase.from('chat_messages').upsert({
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
        const { error: photoReserveError } = await supabase.from('chat_messages').upsert({
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
            await supabase.from('chat_messages').delete().eq('amo_message_id', `ga:${photoMessageId}`)
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

  if (needsCityAnchor) {
    // Тот же приём для CITY_QUESTION: если клиент не назовёт город 5 минут,
    // followup-scheduler.ts сам пришлёт блок «до/после» (sendResultsPhotoOnly).
    const { error: cityAnchorError } = await supabase.from('chat_messages').upsert({
      amo_message_id: `${CITY_WAIT_ANCHOR_ID_PREFIX}:${input.providerMessageId}`,
      chat_id: input.chatId,
      direction: 'out',
      sender: 'bot',
      text: CITY_WAIT_ANCHOR_TEXT,
    }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
    if (cityAnchorError) console.error('greenapi bot-reply: city anchor failed', cityAnchorError.message)
  }

  if (needsCodAnchor) {
    // Клиент попросил оплату при получении — ждём адрес+телефон следующим
    // сообщением (см. обработку COD_WAIT_ANCHOR_ID_PREFIX в
    // processInboundGreenApiMessageNow, срабатывает раньше общего скрипта).
    // Ключ — chat_id, не providerMessageId: upsert перезаписывает ту же
    // строку при каждой новой просьбе о COD в этом чате, а не копится по
    // одной на сообщение.
    const { error: codAnchorError } = await supabase.from('chat_messages').upsert({
      amo_message_id: `${COD_WAIT_ANCHOR_ID_PREFIX}:${input.chatId}`,
      chat_id: input.chatId,
      direction: 'out',
      sender: 'bot',
      text: COD_WAIT_ANCHOR_TEXT,
    }, { onConflict: 'amo_message_id' })
    if (codAnchorError) console.error('greenapi bot-reply: cod anchor failed', codAnchorError.message)
  }

  if (stageAction && !opts.dryRun) {
    const result = await advanceDealFromBotAction(externalKey, stageAction)
    if (!result.ok && result.error) {
      console.error('greenapi bot-reply: stage advance failed', stageAction, result.error)
    }
  }
}
