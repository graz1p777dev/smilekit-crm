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
  // Тот же живой баг, что у verify_receipt — длинное голосовое (до 20 МБ)
  // на распознавание речи может не уложиться в дефолтные 15 с.
  const result = await smilekitBotFetch<{ transcript: string }>('/internal/transcribe', {
    method: 'POST',
    body: { audioBase64: audio.toString('base64'), filename: `voice.${extension}` },
    timeoutMs: 45_000,
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

const CITY_QUESTION = 'Подскажите, пожалуйста, из какого вы города?'

// Отправляется голосовым (.ogg, см. voiceReplies ниже) — клиент текст не
// видит, поэтому вариации бессмысленны, текст только один.
const FIRST_USE_EFFECT = DEFAULT_FIRST_USE_EFFECT

const LOW_STOCK_DISCOUNT_CTA = DEFAULT_LOW_STOCK_CTA

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
const REGIONAL_DELIVERY_TEMPLATE = 'Да, у нас есть доставка через Ылдам Экспресс 🚚✅ За 1 день доставим прям до дома.'

// Живой баг: список городов был совсем коротким (по паре на страну), и всё,
// что в него не попадало — включая настоящие города/райцентры — уходило в
// расплывчатую эвристику shouldSendResultsAfterLocation (см. ниже), которая
// с тем же успехом принимала за «город» вообще любую короткую фразу без «?»
// («Отдыхайте» тоже проходило). Список расширен под все страны из
// CLAUDE.md (Кыргызстан/Казахстан/Узбекистан + Россия через СДЭК) —
// известный город теперь узнаётся напрямую, а не по грубому «похоже на
// ответ» правилу.
const OTHER_KZ_REGION_TEMPLATE = 'Отлично, доставим — по остальным регионам Казахстана ориентировочно за 1–3 дня'
const OTHER_UZ_CITY_TEMPLATE = 'Отлично, доставим — точный срок по Узбекистану уточним отдельно'

const DELIVERY_TEMPLATES: [RegExp, string][] = [
  // Префиксом, а не целым словом (как остальные города ниже) — живой баг:
  // опечатка «бишкеа» не совпадала с «бишкек» и уходила в общий шаблон
  // «Ылдам Экспресс» вместо 30-минутной доставки по Яндексу. Матчится по
  // normalized ниже, где щ уже сложено в ш — «бищкека» тоже совпадает.
  [/бишке|токмо/, 'Отлично, у нас есть доставка через Яндекс, за 30 минут доставим'],
  // Остальной Кыргызстан — райцентры и крупные города вне Бишкека/Токмока.
  [
    /(?<![a-zа-яё0-9_])ош(?![a-zа-яё0-9_])|джалал-?абад|каракол|нарын|талас|баткен|балыкч|манас|кара-?балт|кант(?![а-яё])|кызыл-?кия|узген|кара-?к[уе]л|майлуу-?су|исфана|кочкор|кемин|чолпон-?ата|ат-?баши|сузак|араван|ноокат|айдаркен|сулюкта|кара-?су(?![а-яё])|исык-?кул|иссык-?кул|жалал-?абад/,
    REGIONAL_DELIVERY_TEMPLATE,
  ],
  [/алмат/, 'Отлично, доставим в Алматы — ориентировочно в течение 30 минут'],
  [
    /астан|шымкент|караганд|актюбе|актобе|тараз(?![а-яё])|павлодар|усть-?камен|өскемен|оскемен|семей|атырау|костанай|кызылорда|уральск|орал(?![а-яё])|петропавл|актау|темиртау|туркестан/,
    OTHER_KZ_REGION_TEMPLATE,
  ],
  [/ташкент/, 'Отлично, доставим в Ташкент — ориентировочно в течение 1 часа'],
  [
    /самарканд|бухар|андижан|наманган|фергана|нукус|карши(?![а-яё])|термез|ургенч|коканд|жиззах|джиззах/,
    OTHER_UZ_CITY_TEMPLATE,
  ],
  [
    /москв|росси|петербург|питер(?![а-яё])|новосибирск|екатеринбург|казан(?![а-яё])/,
    'Своего склада в России нет, отправляем через СДЭК — доставка от 7 дней. Точную стоимость доставки уточним отдельно',
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
const NOT_A_LOCATION_REPLY =
  /^(?:спасибо|спс|благодар\w*|хорошо|ладно|ок|окей|поняла?|понятно|ясно|отдыхайте|пока|до\s*связи|до\s*свидания|угу|ага|давайте(?:\s+оформ\w*)?|потом|позже|подума[юем]|извини\w*|прости\w*|удачи|спокойной\s*ночи|доброй\s*ночи|хорошего\s*дня)[\s!.,)😊😉👍🙏]*$/i

function shouldSendResultsAfterLocation(text: string, historyText: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ')
  const priorPrice = historyText.includes('цена') || historyText.includes('сом')
  if (!priorPrice || LINK_IN_MESSAGE.test(text) || GREETING_ONLY.test(text)) return false
  if (NOT_A_LOCATION_REPLY.test(normalized)) return false
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
const ORDER_INTENT =
  /хочу\s+(?:заказать|купить|взять|одну|одн[уо]\s+(?:коробк|пачк|упаковк)|сделать\s+заказ)|(?:как|где|можно)\s+(?:заказать|купить|оформить|оплатить|сделать\s+заказ)|закажу|заказать|куплю|(?<![a-zа-яё0-9_])оформ\w*|(?<![a-zа-яё0-9_])беру(?![a-zа-яё0-9_])|возьму|реквизит|куда\s+(?:скинуть|перевести|оплатить|платить|переводить)|как\s+(?:оплатить|платить|оплачивать)|способ\s+оплаты|оплачу|готов[аы]?\s+(?:оплатить|купить|заказать)|номер\s+карты|скин(?:ь|ьте)\s+(?:номер|реквизит|карту|qr)|\bqr[\s-]?код/i

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
const AI_IMPROVISED_CHECKLIST =
  /(?:чек|скриншот)[^.!?\n]{0,40}(?:оплат|перевод)|(?:адрес|номер\s+телефона)[^.!?\n]{0,40}(?:чек|оплат)|реквизит|(?:пришлите|отправьте|напишите|укажите|скиньте)[^.!?\n]{0,40}(?:адрес|чек|номер\s+телефона)|(?:для|чтобы)\s+оформ\w*[^.!?\n]{0,60}(?:нужн|пришлите|отправьте|укажите)/i

// Подводка перед фото — дословно как в Telegram (__main__.py).
const RESULTS_INTRO = 'Вот результат нашего клиента до и после применения 👇'

// CTA после блока результата (доставка -> фото -> голосовое). Раньше шёл
// сразу третьим сообщением — клиент не успевал даже дослушать голосовое,
// как бот уже «оформлял». Теперь CTA уходит через FOLLOWUP_CTA_SILENCE_MS
// (5 минут) молчания клиента (followup-scheduler.ts): в конце блока в
// историю пишется служебный якорь FOLLOWUP_ANCHOR_TEXT, и если он так и
// остался последней записью в чате — планировщик шлёт этот вопрос. Если
// клиент что-то написал — якорь перестаёт быть последним, CTA не уходит
// (дальше бот сам предлагает оформить в ходе диалога). Скидку сама по
// себе не предлагаем — только если клиент на этот вопрос ответит отказом
// (NEGATIVE_ONLY ниже).
export const ORDER_CTA_TEXT = 'Вам оформить доставку?'
// Якорь — тот же приём, что ga:claim:*: сидит в amocrm_messages, клиенту не
// уходит, в «Лаборатории» и истории для ИИ скрыт (префикс ga:claim:).
export const FOLLOWUP_ANCHOR_ID_PREFIX = 'ga:claim:followup'
export const FOLLOWUP_ANCHOR_TEXT = '[ожидание оформления]'
export const FOLLOWUP_CTA_ID_PREFIX = 'ga:bot:cta-followup'
// Тот же якорный приём, что FOLLOWUP_ANCHOR, но для вопроса CITY_QUESTION:
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

// Дожим, если клиент молчит 30 минут после ЛЮБОГО последнего ответа бота
// (в т.ч. после CTA-follow-up — но и на любом другом этапе диалога), как
// idle_nudge в Telegram-боте (__main__.py). Несколько вариантов текста, а не один и тот же — раньше повторный
// дожим (после того, как клиент снова замолчал уже после ответа на первый)
// слал буквально то же самое сообщение; ротация по номеру попытки убирает
// повтор. Если клиент вообще не ответил на дожим 24 часа — вторая волна не
// повторяет тот же текст, а сразу предлагает скидку (та же лестница
// 13%→20%, что и nextDiscountOffer) — как в обычной email/WhatsApp-рассылке.
export const IDLE_NUDGE_VARIANTS = [
  'Вы ещё здесь? 😊 Кстати, у нас есть сайт — там ответы на частые вопросы и настоящие результаты покупателей: https://smilekit.vercel.app\n\nЕсли что-то ещё интересует — с радостью подскажу, оформим, когда будете готовы 😊',
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
    .from('amocrm_messages')
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

const SCAM_DOUBT =
  /(?:вы\s+)?(?:точно\s+)?не\s+мошенник|мошенники\s*\?|(?:это\s+)?(?:точно\s+)?не\s+(?:обман|развод|скам|фейк)|без\s+обмана|(?:это\s+)?(?:все|всё)?\s*реально\s*(?:да|\?)|не\s+кин[её]те|вам\s+можно\s+доверять|можно\s+(?:ли\s+)?вам\s+верить|вы\s+настоящие/i

// Тот же роутер-сценарий "safety_composition", что в Telegram-боте
// (service.py ROUTE_TOOL): вопрос про состав/безопасность/вред для эмали
// или дёсен. Раньше в WhatsApp такой ветки не было вовсе — вопрос уходил в
// ИИ, который сочинял свой ответ вместо утверждённого текста.
const SAFETY_COMPOSITION_DOUBT =
  /вред(?:ит|но|ен)?[^.!?]{0,15}(?:эмал|дёсн|десн)|(?:эмал|дёсн|десн)[^.!?]{0,15}вред|опасн\w*[^.!?]{0,15}(?:эмал|дёсн|десн|состав)|(?:безопасн\w*[^.!?]{0,15}состав|состав[^.!?]{0,15}безопасн)/i

const SAFETY_COMPOSITION_VARIANTS = [
  DEFAULT_SAFETY_COMPOSITION,
  'Состав полностью безопасен и никак не вредит эмали зубов. То фото результата, что я присылала, — это мои собственные зубы 😊 Могу прислать состав, если интересно.',
  'Не переживайте, состав абсолютно безопасный, эмаль не повреждает. Результат на фото — мои собственные зубы. Хотите — пришлю состав.',
  'Состав у нас безопасный, эмали не вредит совсем. И фото результата, которое я отправляла, — это мои собственные зубы. Если нужно, отправлю состав.',
]

// Живой баг: клиент спросил стоимость/платность доставки отдельно от
// названия города («Имею ввиду доставку») — ИИ-фолбэк выдумал «бесплатно»,
// хотя в базе знаний доставки такого нет (только «оплата при получении» по
// Бишкеку/Токмоку или предоплата 400 сом для остальных регионов КР). Теперь
// это детерминированная ветка — деньги не оставляем на усмотрение ИИ.
const DELIVERY_COST_QUESTION =
  /сколько\s*(?:будет|стоит|выйдет)[^?]{0,20}достав|достав\w*[^?]{0,15}(?:плат|бесплат)|(?:плат|бесплат)\w*[^?]{0,15}достав|имею\s*ввиду\s*доставк/i
const DELIVERY_PAYMENT_BISHKEK = 'Доставка курьером, оплата — при получении 😊'
const DELIVERY_PAYMENT_REGIONS = 'По регионам — предоплата 400 сом, остальная сумма при получении 😊'

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

  await supabase.from('amocrm_messages').upsert({
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
    const { error: photoReserveError } = await supabase.from('amocrm_messages').upsert({
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
        await supabase.from('amocrm_messages').delete().eq('amo_message_id', photoMessageId)
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
    .from('amocrm_messages')
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
  // Автопроверка отработала и уверенно говорит «это не скриншот оплаты»
  // (например, фото зубов, а не чек) — не заказ и не «чек не прошёл
  // проверку», а вообще другая картинка. Заказ на такое заводить не нужно.
  const notAReceipt = check?.is_real_receipt_screenshot === false && checkUnavailable
  const reply = verified ? RECEIPT_ACCEPTED : notAReceipt ? RECEIPT_NOT_A_RECEIPT : RECEIPT_REJECTED

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

  // Не чек — отвечаем и молча выходим: не заводим заказ, не шлём в группу
  // доставки, не двигаем сделку на этап «заказ». Ниже — только реальные чеки
  // (принятые и требующие ручной проверки).
  if (notAReceipt) return

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

  // Живой баг: transcribeGreenApiVoice кидает исключение при сбое скачивания
  // или слишком большом файле (не возвращает null, как для просто пустой
  // расшифровки) — без try/catch это долетало необработанным отклонением
  // промиса до webhook-роута (там `void processInboundGreenApiMessage(...)`
  // без .catch), и клиент оставался вообще без ответа, без видимого следа
  // в логах, привязанного к конкретному сообщению.
  let transcript: string | null
  try {
    transcript = await transcribeGreenApiVoice(input)
  } catch (error) {
    console.error('greenapi bot-reply: voice download/transcription threw', input.providerMessageId, error)
    return
  }
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

const DEBOUNCE_MS = 50_000

interface PendingGreenApiReplyBatch {
  texts: string[]
  timer: ReturnType<typeof setTimeout>
}

// Клиент часто пишет несколько сообщений подряд отдельными пузырями
// («Здравствуйте» → «Бишкек» → «сколько стоит») — без буфера бот отвечал на
// каждое сразу и вразнобой, вместо одного связного ответа. Ждём 50 секунд
// тишины после последнего сообщения и отвечаем на все разом. В «Лаборатории»
// (dryRun) ждать не нужно — там тестируют по одному сообщению за раз и ждут
// ответ сразу.
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
    .from('amocrm_messages')
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
  let needsFollowupAnchor = false
  let needsCityAnchor = false
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
  // результата — голосовое «эффект с первого раза» и есть подводка к
  // заказу, «хочу»/«давайте» на него — согласие, а не тема для ИИ.
  const afterOrderPrompt = ORDER_CTA_MARKER.test(lastBotMessage) || lastBotMessage === T.firstUseEffect
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
    replies.push(pickVariant(SAFETY_COMPOSITION_VARIANTS))
  } else if (EFFECT_DURATION_QUESTION.test(input.text)) {
    replies.push(pickVariant(EFFECT_DURATION_VARIANTS))
  } else if (DELIVERY_COST_QUESTION.test(input.text)) {
    const cityTemplate = deliveryTemplateForCity(input.text) ?? deliveryTemplateForCity(historyText)
    if (cityTemplate) {
      const isBishkekOrTokmok = /бишке|токмо/.test(input.text.replace(/щ/g, 'ш')) || /бишке|токмо/.test(historyText)
      replies.push(cityTemplate, isBishkekOrTokmok ? DELIVERY_PAYMENT_BISHKEK : DELIVERY_PAYMENT_REGIONS)
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
  } else if (ORDER_INTENT.test(input.text) || acceptedOrderCta) {
    // QR отправляется сразу вместе с чек-листом (ниже, sendPaymentQr) — раньше
    // WhatsApp не умел слать картинки, поэтому клиента отправляли к менеджеру
    // за реквизитами. Green API картинки шлёт, так что ждать «подтверждения»
    // перед выдачей реквизитов больше не нужно.
    replies.push(T.orderChecklist)
    voiceReplies.add(T.orderChecklist)
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
    // Доставка -> фото (в цикле отправки ниже) -> голосовое. CTA «вам
    // оформить со скидкой?» НЕ сразу: через 5 минут молчания клиента его
    // шлёт followup-scheduler.ts по якорю (см. FOLLOWUP_ANCHOR_TEXT).
    // Живой баг: оба захвата (claimOnce/claimResultsBlock) раньше выполнялись
    // безусловно ДО выбора ветки — короткое «давайте оформим» без города
    // ложно проходило shouldSendResultsAfterLocation, «съедало» claim и следом
    // за чек-листом заказа (ветка ORDER_INTENT выше) улетало ещё и фото
    // «до/после», хотя город не называли. Теперь захват — только здесь,
    // и только когда эта ветка реально выбрана (после ORDER_INTENT и прочих).
    if (await claimOnce(supabase, input.chatId, 'results-delivery')) {
      replies.push(deliveryTemplate, T.firstUseEffect)
      voiceReplies.add(T.firstUseEffect)
      needsFollowupAnchor = true
      if (await claimResultsBlock(supabase, input.chatId)) {
        sendResultsPhotoThisTurn = true
      }
    }
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
    // Живой баг: ИИ сам «оформлял заказ» — сочинял свой чек-лист (просил
    // адрес/чек/реквизиты в произвольной форме) без QR, хотя на это есть
    // утверждённый шаблон. Если модель явно перешла к оформлению — шлём
    // шаблон и QR вместо её текста.
    if (replies.some((part) => AI_IMPROVISED_CHECKLIST.test(part))) {
      replies.length = 0
      replies.push(T.orderChecklist)
      voiceReplies.add(T.orderChecklist)
      sendPaymentQr = true
      stageAction = 'order'
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
      const voiceName =
        text === T.firstUseEffect ? 'first_use_effect.ogg'
        : text === T.orderChecklist ? 'order_checklist.ogg'
        : 'not_scam.ogg'
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
      // Голосовое сразу после QR — пояснение по оплате поверх картинки с кодом.
      const qrVoiceMessageId = `ga:bot:${input.providerMessageId}:qr-voice`
      const { error: qrVoiceReserveError } = await supabase.from('amocrm_messages').upsert({
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
          await supabase.from('amocrm_messages').delete().eq('amo_message_id', qrVoiceMessageId)
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
    // Якорь только в БД, клиенту не уходит: followup-scheduler.ts раз в
    // минуту ищет чаты, где он — последняя запись и прошло 5+ минут тишины,
    // и шлёт CTA. Любое сообщение клиента сдвигает якорь — CTA не уходит.
    const { error: anchorError } = await supabase.from('amocrm_messages').upsert({
      amo_message_id: `${FOLLOWUP_ANCHOR_ID_PREFIX}:${input.providerMessageId}`,
      chat_id: input.chatId,
      direction: 'out',
      sender: 'bot',
      text: FOLLOWUP_ANCHOR_TEXT,
    }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
    if (anchorError) console.error('greenapi bot-reply: followup anchor failed', anchorError.message)
  }

  if (needsCityAnchor) {
    // Тот же приём для CITY_QUESTION: если клиент не назовёт город 5 минут,
    // followup-scheduler.ts сам пришлёт блок «до/после» (sendResultsPhotoOnly).
    const { error: cityAnchorError } = await supabase.from('amocrm_messages').upsert({
      amo_message_id: `${CITY_WAIT_ANCHOR_ID_PREFIX}:${input.providerMessageId}`,
      chat_id: input.chatId,
      direction: 'out',
      sender: 'bot',
      text: CITY_WAIT_ANCHOR_TEXT,
    }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
    if (cityAnchorError) console.error('greenapi bot-reply: city anchor failed', cityAnchorError.message)
  }

  if (stageAction && !opts.dryRun) {
    const result = await advanceDealFromBotAction(externalKey, stageAction)
    if (!result.ok && result.error) {
      console.error('greenapi bot-reply: stage advance failed', stageAction, result.error)
    }
  }
}
