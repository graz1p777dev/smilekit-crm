// ИИ-ответ клиенту в WhatsApp-чате amoCRM.
//
// Мозг — тот же Telegram-бот Smilekit (черновик менеджера + супервизор):
// CRM вызывает его /internal/lab с историей этого чата и отправляет готовый
// ответ через amojo (см. chat.ts). История живёт у нас (amocrm_messages),
// наш сервер — мастер; amoCRM только транспорт.

import { createAdminClient } from '@/lib/supabase/admin'
import { smilekitBotFetch } from '@/lib/smilekit-bot-api'
import { upsertDealFromInbound } from '@/lib/deals/auto-create'
import { advanceDealFromBotAction } from '@/lib/deals/advance-stage'
import { getAmoChatHistory, sendAmoChatMessage, sendAmoChatVoice } from '@/lib/amocrm/chat'
import { syncAmoChatHistory } from '@/lib/amocrm/history'
import { createLimiter } from '@/lib/concurrency-limit'
import { isIntegrationBotEnabled } from '@/lib/integration-status'

export interface InboundAmoMessage {
  amoMessageId: string
  chatId: string
  leadId: string | null
  contactId: string | null
  authorName: string | null
  customerPhone?: string | null
  text: string
  messageType?: string
}

const VOICE_TYPES = new Set(['voice', 'audio'])
const MAX_VOICE_BYTES = 20 * 1024 * 1024

async function transcribeAmoVoice(input: InboundAmoMessage): Promise<string | null> {
  if (!VOICE_TYPES.has(input.messageType ?? '')) return input.text
  let remote = null
  for (let attempt = 0; attempt < 3 && !remote?.mediaUrl; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
    remote = (await getAmoChatHistory(input.chatId, 200))
      .find((message) => message.amoMessageId === input.amoMessageId) ?? null
  }
  if (!remote?.mediaUrl) return null
  const response = await fetch(remote.mediaUrl, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`amo voice download: HTTP ${response.status}`)
  const size = Number(response.headers.get('content-length') || 0)
  if (size > MAX_VOICE_BYTES) throw new Error('amo voice download: file is too large')
  const audio = Buffer.from(await response.arrayBuffer())
  if (!audio.length || audio.length > MAX_VOICE_BYTES) throw new Error('amo voice download: invalid size')
  const extension = new URL(remote.mediaUrl).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? 'm4a'
  const result = await smilekitBotFetch<{ transcript: string }>('/internal/transcribe', {
    method: 'POST',
    body: {
      audioBase64: audio.toString('base64'),
      filename: `${remote.messageType === 'audio' ? 'audio' : 'voice'}.${extension}`,
    },
  })
  return result.ok ? result.data.transcript.trim() || null : null
}

// ─── Скрипт продаж — порт из Telegram-бота (smilekit_bot/templates.py,
// sales.py, __main__.py). Тексты дословно по ТЗ, держим синхронно с ботом.
// Отличие канала: QR-картинку и фото в WhatsApp через amojo не передать,
// поэтому на этапе оплаты сделка передаётся менеджеру.

const PRODUCT_INFO =
  'Здравствуйте! 😊\n\n' +
  'SmileKit помогает заметно отбелить зубы уже после первого применения.\n\n' +
  '📦 В наборе 14 отбеливающих полосок — это полный курс.\n\n' +
  '💰 ЦЕНА — 1490 СОМ.🇰🇬'

const KYRGYZ_PRODUCT_INFO =
  'Салам! 😊 Бир кутусу — 1490 сом. Ичинде 14 даана тилке бар — бул толук курс. ' +
  'Таасири биринчи колдонуудан кийин эле байкалат.\n\n' +
  'Кайсы шаардан болосуз? Жеткирүү боюнча айтып берем.'

const KYRGYZ_MARKERS =
  /баа|наркы|канча|кайсы|шаар|жеткир|тиш|агарт|колдон|куту|барбы|алам|керек|рахмат|болобу|кантип|эмне/i
const KYRGYZ_PRICE_INTENT = /баа|наркы|канча\s*(?:сом|турат)/i
const LINK_IN_MESSAGE = /(?:https?:\/\/|www\.)\S+/i
const GREETING_ONLY = /^\s*(?:улыбка|здравствуйте|здравствуй|привет|добрый\s+(?:день|вечер|утро))[!,.?\s😊👋]*$/iu
const WHATSAPP_WAITING_PLACEHOLDER = /ожидание сообщения.*проверьте свой телефон/i

const CITY_QUESTION = 'Подскажите, пожалуйста, из какого вы города?'

const FIRST_USE_EFFECT =
  'Гарантированно увидите эффект с первого раза 😁. После курса эффект будет постоянный✅😊'

const LOW_STOCK_DISCOUNT_CTA =
  'Кстати, у нас осталось буквально 2 упаковки, поэтому мы их отдаем по скидке 10% ☺️\n' +
  'Оформить вам доставку ?)'

// templates.py: PAYMENT_QR_MESSAGE — дословно. QR-картинку и приём/проверку
// чека для WhatsApp ещё предстоит реализовать (см. ПЕРЕДАЧА-CODEX), поэтому
// пока после чек-листа сделка передаётся менеджеру — временная мера, а не
// то же поведение, что в Telegram.
const ORDER_CHECKLIST =
  'Чтобы оформить заказ, пожалуйста, отправьте 😊\n\n' +
  '• чек об оплате;\n\n' +
  '• адрес доставки;\n\n' +
  '• номер телефона.'

const RETURNING_GREETING_REPLIES = [
  'Здравствуйте! 😊 Рада снова вас видеть. Чем могу помочь?',
  'Здравствуйте! 😊 Конечно, я на связи. Что подсказать?',
  'Здравствуйте! 😊 Продолжим — чем могу помочь?',
]

const RETURNING_KYRGYZ_GREETING_REPLIES = [
  'Салам! 😊 Кайрадан көргөнүмө кубанычтамын. Кантип жардам берейин?',
  'Салам! 😊 Мен байланышта элем. Эмне боюнча жардам керек?',
]

const COMPLAINT_PROMPT = 'Подскажите, пожалуйста, что вас не устроило — для улучшения нашего сервиса.'

const COOPERATION_REPLY =
  'Спасибо за интерес! Вопросами сотрудничества и опта занимается наш менеджер — он свяжется с вами в ближайшее время.'

const DELIVERY_TEMPLATES: [RegExp, string][] = [
  [/бишкек|токмок/, 'Отлично, у нас есть доставка через Яндекс, за 30 минут доставим'],
  [
    /\bош\b|джалал-?абад|каракол|нарын|талас|баткен|балыкч|манас/,
    'Да, у нас есть доставка через Ылдам Экспресс 🚚✅. Если оформить сейчас, доставка будет уже завтра или послезавтра',
  ],
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

// sales.py: _ORDER_INTENT + _PAYMENT_INFO_REQUEST — клиент готов оформлять
// или спрашивает, как платить.
const ORDER_INTENT =
  /хочу\s+(?:заказать|купить|взять)|(?:как|где)\s+(?:заказать|купить|оформить)|закажу|заказать|оформить|оформляйте|оформляем|\bберу\b|возьму|можно\s+оформить|реквизит|куда\s+(?:скинуть|перевести|оплатить|платить)|как\s+оплатить|способ\s+оплаты|\bqr[\s-]?код/i

const SMILEKIT_RESULTS_URL = 'https://smilekit.vercel.app/#results'

// templates.py: DOUBT_RESULT_REPLY — дословно по ТЗ, «гарантируем», без
// «у большинства», сохранено как есть. Срабатывает на сомнения в честности/
// реальности ДО покупки — добавлена ссылка на страницу с реальными фото
// до/после и перепиской с покупателями (проще, чем идти в Instagram).
const DOUBT_RESULT_REPLY =
  'Понимаю, лучше один раз увидеть 😊 Вот страница с настоящими фото до/после ' +
  `и перепиской с нашими покупателями — без прикрас: ${SMILEKIT_RESULTS_URL}\n\n` +
  'Мы гарантируем эффект уже после первого применения.'

// sales.py: _SCAM_DOUBT + формулировки из реальных диалогов WhatsApp
// («это все реально да», «без обмана»). Проверяется раньше жалоб —
// слова пересекаются.
const SCAM_DOUBT =
  /(?:вы\s+)?(?:точно\s+)?не\s+мошенник|мошенники\s*\?|(?:это\s+)?(?:точно\s+)?не\s+(?:обман|развод|скам|фейк)|без\s+обмана|(?:это\s+)?(?:все|всё)?\s*реально\s*(?:да|\?)|не\s+кин[её]те|вам\s+можно\s+доверять|можно\s+(?:ли\s+)?вам\s+верить|вы\s+настоящие/i

// sales.py: _COMPLAINT_MARKERS / _COOPERATION_MARKERS.
const COMPLAINT =
  /развод|обман(?:ули)?|кинул|мошенник|верните\s+деньги|хочу\s+возврат|ужасн(?:о|ый|ая)|отвратительн|никогда\s+(?:больше\s+)?не\s+куплю|не\s+помогл|разочарован/i
const COOPERATION =
  /сотрудничеств|оптом|\bопт\b|дистрибьютор|дилер|партн[её]р|реселлер|перепродаж|b2b|блогер/i

// Порт stage_action_for_inbound из бота (smilekit_bot/crm.py) — та же
// трёхуровневая эвристика намерения. Держим синхронно с ботом.
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

/**
 * Исходящее сообщение из вебхука. Если это НЕ эхо только что отправленного
 * ботом текста — в чат вступил живой менеджер (из амо или WhatsApp Business).
 * Сохраняем как operator, чтобы ответ был виден в общей истории диалога.
 */
export async function registerOutgoingAmoMessage(input: InboundAmoMessage): Promise<void> {
  const supabase = createAdminClient()
  const { data: recentBot } = await supabase
    .from('amocrm_messages')
    .select('id')
    .eq('chat_id', input.chatId)
    .eq('sender', 'bot')
    .eq('text', input.text)
    .gte('created_at', new Date(Date.now() - 5 * 60_000).toISOString())
    .limit(1)
  if (recentBot?.length) return // эхо нашей же отправки через amojo

  await supabase.from('amocrm_messages').upsert(
    {
      amo_message_id: input.amoMessageId,
      chat_id: input.chatId,
      lead_id: input.leadId,
      contact_id: input.contactId,
      direction: 'out',
      sender: 'operator',
      text: input.text,
    },
    { onConflict: 'amo_message_id', ignoreDuplicates: true }
  )
}

// Сообщения одного чата обрабатываем строго по очереди: два входящих с
// разницей в секунды иначе генерят два параллельных ответа с одинаковым
// контекстом (клиент получает дубль). Один инстанс на Railway — внутрипроцессной
// цепочки достаточно.
const chatQueues = new Map<string, Promise<void>>()

// chatQueues сериализует только ВНУТРИ одного чата — разных чатов может
// одновременно обрабатываться сколько угодно, и при всплеске сообщений
// (амоCRM шлёт события пачками) это забивало тот же fetch-агент/Supabase,
// которым обслуживаются обычные запросы CRM: карточка сделки виснет на
// «Загружаем диалог…» дольше клиентского тайм-аута, хотя сама база отвечает
// мгновенно (см. ПЕРЕДАЧА-CODEX-amocrm-канал.md, «Найденный и доказанный
// root cause», проверено 2026-08-12 прямым тестом с того же прод-инстанса).
// Общий потолок — сколько РАЗНЫХ чатов обрабатывается одновременно.
const globalAmoProcessingLimit = createLimiter(4)

/**
 * Менеджер написал в чат — бот больше не отвечает, ПОКА владелец явно не
 * вернёт ему управление тумблером в карточке сделки (amocrm_chat_control).
 * Override действует только до следующего сообщения менеджера: если тот
 * снова написал позже, чем включили бота, управление опять у человека —
 * тумблер не «навсегда», а на текущий разговор.
 */
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
  return true // менеджер написал позже, чем включили бота — управление снова у него
}

/** Стоп-список рассылок (campaign_opt_outs) с флагом block_bot_replies —
 * бот этому номеру не пишет вообще ничего, даже отвечая на входящее. */
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

export interface AmoChatControlStatus {
  chatId: string | null
  managerControls: boolean
}

/** Статус чата сделки для тумблера в карточке (DealModal). */
export async function getAmoChatControlStatus(leadId: string): Promise<AmoChatControlStatus> {
  const supabase = createAdminClient()
  const { data: chatRow } = await supabase
    .from('amocrm_messages')
    .select('chat_id')
    .eq('lead_id', leadId)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  const chatId = (chatRow as { chat_id?: string } | null)?.chat_id ?? null
  if (!chatId) return { chatId: null, managerControls: false }
  return { chatId, managerControls: await isManagerControllingChat(supabase, chatId) }
}

/**
 * Тумблер в карточке сделки: true — вернуть чат боту, false — явно забрать
 * управление менеджеру, не дожидаясь его сообщения в чате.
 */
export async function setAmoChatBotEnabled(chatId: string, botEnabled: boolean, userId: string | null): Promise<void> {
  const supabase = createAdminClient()
  const { error } = await supabase.from('amocrm_chat_control').upsert(
    { chat_id: chatId, bot_enabled: botEnabled, updated_at: new Date().toISOString(), updated_by: userId },
    { onConflict: 'chat_id' }
  )
  if (error) throw new Error(`amocrm chat control upsert: ${error.message}`)
}

async function canSendAmoBotReply(
  supabase: ReturnType<typeof createAdminClient>,
  chatId: string
): Promise<boolean> {
  const [integrationResult, managerControls] = await Promise.all([
    supabase
      .from('integrations')
      .select('is_active, paused_until')
      .eq('name', 'amoCRM')
      .maybeSingle(),
    isManagerControllingChat(supabase, chatId),
  ])
  if (integrationResult.error) return false
  return isIntegrationBotEnabled(integrationResult.data) && !managerControls
}

function enqueueInboundAmoMessage(input: InboundAmoMessage, alreadyStored = false): Promise<void> {
  const prev = chatQueues.get(input.chatId) ?? Promise.resolve()
  const run = prev.then(() =>
    globalAmoProcessingLimit(() => processInboundAmoMessageNow(input, alreadyStored))
  )
  const chain = run.then(
    () => {},
    () => {}
  )
  chatQueues.set(input.chatId, chain)
  chain.then(() => {
    if (chatQueues.get(input.chatId) === chain) chatQueues.delete(input.chatId)
  })
  return run
}

export function processInboundAmoMessage(input: InboundAmoMessage): Promise<void> {
  return enqueueInboundAmoMessage(input)
}

/** Подбирает после рестарта недавние сообщения, оставшиеся без ответа. */
export async function replayRecentUnansweredAmoMessages(minutes = 120): Promise<void> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('amocrm_messages')
    .select('amo_message_id, chat_id, lead_id, contact_id, sender, author_name, text')
    .gte('created_at', new Date(Date.now() - minutes * 60_000).toISOString())
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(500)
  if (error) throw new Error(`recent unanswered lookup failed: ${error.message}`)

  type RecentMessage = {
    amo_message_id: string
    chat_id: string
    lead_id: string | null
    contact_id: string | null
    sender: string
    author_name: string | null
    text: string
  }
  const latestByChat = new Map<string, RecentMessage>()
  for (const row of (data ?? []) as RecentMessage[]) latestByChat.set(row.chat_id, row)
  const unanswered = [...latestByChat.values()].filter((row) => row.sender === 'client')
  if (unanswered.length) {
    console.log(`amocrm bot-reply: replaying ${unanswered.length} unanswered message(s)`)
  }
  await Promise.all(
    unanswered.map((row) =>
      enqueueInboundAmoMessage(
        {
          amoMessageId: row.amo_message_id,
          chatId: row.chat_id,
          leadId: row.lead_id,
          contactId: row.contact_id,
          authorName: row.author_name,
          text: row.text,
        },
        true
      )
    )
  )
}

/**
 * Полный цикл на входящее сообщение: сохранить → сделка → ответ ИИ →
 * отправить в amo → сохранить ответ → продвинуть этап.
 * Вызывается detached из вебхука (амо ждёт 200 быстро) — все сбои в console.
 */
async function processInboundAmoMessageNow(input: InboundAmoMessage, alreadyStored: boolean): Promise<void> {
  const supabase = createAdminClient()
  if (!alreadyStored) {
    const transcript = await transcribeAmoVoice(input)
    if (VOICE_TYPES.has(input.messageType ?? '') && !transcript) {
      console.error('amocrm bot-reply: voice transcription failed', input.amoMessageId)
      return
    }
    if (transcript) input = { ...input, text: transcript }
  }

  // Идемпотентность: ретрай вебхука с тем же amo_message_id не отвечает дважды.
  if (!alreadyStored) {
    const { data: inserted, error: insertError } = await supabase
      .from('amocrm_messages')
      .upsert(
        {
          amo_message_id: input.amoMessageId,
          chat_id: input.chatId,
          lead_id: input.leadId,
          contact_id: input.contactId,
          direction: 'in',
          sender: 'client',
          author_name: input.authorName,
          text: input.text,
        },
        { onConflict: 'amo_message_id', ignoreDuplicates: true }
      )
      .select('id')
    if (insertError) {
      console.error('amocrm bot-reply: insert failed', insertError.message)
      return
    }
    if (!inserted?.length) return // дубль — уже обработано
  }

  const externalKey = input.leadId ? `amocrm:${input.leadId}` : `amocrm-chat:${input.chatId}`
  // Аварийный выключатель: integrations.amoCRM.is_active. Выключен — историю
  // и сделки продолжаем вести, но клиенту не отвечаем и этапы не двигаем.
  const { data: integration } = await supabase
    .from('integrations')
    .select('is_active, paused_until')
    .eq('name', 'amoCRM')
    .maybeSingle()
  const botEnabled = isIntegrationBotEnabled(integration)
  await upsertDealFromInbound({
    externalKey,
    source: 'amocrm',
    customerName: input.authorName,
    customerPhone: input.customerPhone ?? null,
  })
  try {
    await syncAmoChatHistory(input.chatId, input.leadId)
  } catch (error) {
    console.error('amocrm bot-reply: history sync failed', error)
  }
  // Как только в диалог вступил менеджер, бот больше не отвечает в этом
  // чате — пока владелец явно не вернёт ему управление тумблером в карточке
  // сделки (isManagerControllingChat). Синхронизация выше сначала подтягивает
  // свежие исходящие из amojo, поэтому правило действует и для ответов из
  // amoCRM, и из WhatsApp.
  if (await isManagerControllingChat(supabase, input.chatId)) return

  // Номер в стоп-списке с флагом «не отвечать ботом» (campaign_opt_outs,
  // страница «Рассылки») — история и сделка ведутся как обычно, но бот
  // этому номеру не пишет вообще ничего, даже если клиент сам написал первым.
  if (await isPhoneBlockedForBot(supabase, input.customerPhone ?? input.authorName)) return

  // Этапы двигаются ВСЕГДА по намерению клиента — даже когда бот выключен:
  // выключатель глушит только ответы, а не трекинг воронки.
  const inboundAction = COMPLAINT.test(input.text) || COOPERATION.test(input.text)
    ? 'non_standard_request'
    : stageActionForInbound(input.text)
  if (inboundAction) {
    const advanced = await advanceDealFromBotAction(externalKey, inboundAction)
    if (!advanced.ok && advanced.error) {
      console.error('amocrm bot-reply: stage advance failed', inboundAction, advanced.error)
    }
  }

  if (!botEnabled) return

  // История чата: всё до текущего сообщения, старые → новые.
  const { data: rows } = await supabase
    .from('amocrm_messages')
    .select('sender, text, id')
    .eq('chat_id', input.chatId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(31)
  const history = (rows ?? [])
    .reverse()
    .slice(0, -1) // текущее сообщение уходит отдельным параметром message
    .filter((row) => !LINK_IN_MESSAGE.test((row as { text: string }).text))
    .map((row) => ({
      role: (row as { sender: string }).sender === 'client' ? 'user' : 'assistant',
      content: (row as { text: string }).text,
    }))
  const historyText = history.map((item) => item.content.toLowerCase()).join(' ')
  const recentHistoryText = history.slice(-3).map((item) => item.content).join(' ')
  // Иногда WhatsApp присылает техническую заглушку сразу после настоящего
  // сообщения. В таком случае определяем язык и намерение по свежей истории.
  const languageContext = WHATSAPP_WAITING_PLACEHOLDER.test(input.text)
    ? recentHistoryText
    : input.text
  const isKyrgyz = KYRGYZ_MARKERS.test(languageContext)

  // Скриптовые ветки — как в Telegram-обработчике (__main__.py), без ИИ.
  const replies: string[] = []
  const voiceReplies = new Set<string>()
  let sendResultPhotos = shouldSendResultsAfterLocation(input.text, historyText)
  let stageAction: string | null = null
  const deliveryTemplate = deliveryTemplateForCity(input.text)

  if (history.length > 0 && GREETING_ONLY.test(input.text)) {
    // Постоянный клиент поздоровался посреди диалога — не перезапускаем
    // воронку заново (__main__.py: is_greeting_only для не-нового диалога).
    replies.push(
      isKyrgyz
        ? RETURNING_KYRGYZ_GREETING_REPLIES[Math.floor(Math.random() * RETURNING_KYRGYZ_GREETING_REPLIES.length)]
        : RETURNING_GREETING_REPLIES[Math.floor(Math.random() * RETURNING_GREETING_REPLIES.length)]
    )
  } else if (LINK_IN_MESSAGE.test(input.text) || GREETING_ONLY.test(input.text)) {
    // Рекламная ссылка и слово-триггер «Улыбка» не являются вопросом клиента:
    // не обсуждаем ссылку, а запускаем обычный старый сценарий знакомства.
    replies.push(PRODUCT_INFO, CITY_QUESTION)
  } else if (isKyrgyz && KYRGYZ_PRICE_INTENT.test(languageContext)) {
    replies.push(KYRGYZ_PRODUCT_INFO)
  } else if (history.length === 0) {
    replies.push(PRODUCT_INFO, CITY_QUESTION)
  } else if (SCAM_DOUBT.test(input.text)) {
    replies.push(DOUBT_RESULT_REPLY)
    voiceReplies.add(DOUBT_RESULT_REPLY)
  } else if (COMPLAINT.test(input.text)) {
    replies.push(COMPLAINT_PROMPT)
  } else if (COOPERATION.test(input.text)) {
    replies.push(COOPERATION_REPLY)
  } else if (ORDER_INTENT.test(input.text)) {
    // Готов оформлять. QR в WhatsApp не передать — данные собирает бот,
    // оплату закрывает менеджер: сделка сразу «Передан менеджеру».
    replies.push(ORDER_CHECKLIST)
    stageAction = 'order'
  } else if (deliveryTemplate && (historyText.includes('цена') || historyText.includes('сом'))) {
    // Клиент назвал город после цены — готовый сценарий: доставка, эффект, CTA.
    replies.push(deliveryTemplate, FIRST_USE_EFFECT)
    replies.push(
      historyText.includes('скидк')
        ? 'Оформить вам? Пока есть в наличии.'
        : LOW_STOCK_DISCOUNT_CTA
    )
    sendResultPhotos = true
    voiceReplies.add(FIRST_USE_EFFECT)
  }

  if (replies.length === 0) {
    // Не скриптовый случай — обычная генерация тем же мозгом бота
    // (черновик менеджера + супервизор из настроек CRM).
    const labMessage = isKyrgyz
      ? `${input.text}\n\nЖоопту толугу менен кыргыз тилинде бер. Орусча сөздөрдү аралаштырба.`
      : input.text
    const lab = await smilekitBotFetch<{ reply: string }>('/internal/lab', {
      method: 'POST',
      body: { message: labMessage, history },
    })
    if (!lab.ok) {
      console.error('amocrm bot-reply: lab failed', lab.error)
      return
    }
    const reply = lab.data.reply?.trim()
    if (!reply) return
    // Бот делит длинный ответ тегом <NEXT_MESSAGE> (Telegram шлёт частями) —
    // в WhatsApp тег утекал клиенту текстом. Делим так же, как Telegram.
    replies.push(
      ...reply
        .split(/<NEXT_MESSAGE>/i)
        .map((part) => part.trim())
        .filter(Boolean)
    )
    if (replies.length === 0) return
  }

  for (let index = 0; index < replies.length; index++) {
    // Генерация и паузы между сообщениями занимают время. За это время бот
    // могли выключить или менеджер мог забрать чат — проверяем прямо перед
    // каждой фактической отправкой, а не только в начале обработки.
    if (!(await canSendAmoBotReply(supabase, input.chatId))) return
    const text = replies[index]
    const botMessageId = `bot:${input.amoMessageId}:${index}`
    // Записываем до отправки: исходящий webhook amoCRM может вернуться раньше,
    // чем завершится sendAmoChatMessage. Тогда он всё равно распознается как
    // эхо бота, а не как вступивший в чат менеджер.
    const { error: reserveError } = await supabase.from('amocrm_messages').upsert({
      amo_message_id: botMessageId,
      chat_id: input.chatId,
      lead_id: input.leadId,
      contact_id: input.contactId,
      direction: 'out',
      sender: 'bot',
      text,
    }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
    if (reserveError) {
      console.error('amocrm bot-reply: bot message reserve failed', reserveError.message)
      return
    }
    try {
      const voiceName = text === FIRST_USE_EFFECT ? 'first_use_effect.ogg' : 'not_scam.ogg'
      const voiceBaseUrl = process.env.SMILEKIT_BOT_API_URL?.replace(/\/$/, '')
      if (voiceReplies.has(text) && voiceBaseUrl && process.env.AMOCRM_VOICE_SEND_ENABLED === 'true') {
        try {
          await sendAmoChatVoice({
            chatId: input.chatId,
            leadId: input.leadId,
            contactId: input.contactId,
            transcript: text,
            mediaUrl: `${voiceBaseUrl}/media/voice/${voiceName}`,
          })
        } catch (error) {
          console.error('amocrm bot-reply: voice send failed, using text', error)
          await sendAmoChatMessage({ chatId: input.chatId, leadId: input.leadId, contactId: input.contactId, text })
        }
      } else {
        await sendAmoChatMessage({ chatId: input.chatId, leadId: input.leadId, contactId: input.contactId, text })
      }
    } catch (error) {
      await supabase.from('amocrm_messages').delete().eq('amo_message_id', botMessageId)
      console.error('amocrm bot-reply: send failed', error)
      return
    }
    if (sendResultPhotos && index === 0 && !replies.some((r) => r.includes(SMILEKIT_RESULTS_URL))) {
      // Прямая отправка фото через amojo ненадёжна (WhatsApp иногда доставляет
      // только подпись без картинки, см. ПЕРЕДАЧА-CODEX). Ссылка на страницу
      // с фото до/после работает всегда и не зависит от формата amojo.
      if (!(await canSendAmoBotReply(supabase, input.chatId))) return
      const photoMessageId = `bot:${input.amoMessageId}:results-link`
      const text = `Вот страница с реальными фото до/после наших клиентов 📸 ${SMILEKIT_RESULTS_URL}`
      const { error: photoReserveError } = await supabase.from('amocrm_messages').upsert({
        amo_message_id: photoMessageId,
        chat_id: input.chatId,
        lead_id: input.leadId,
        contact_id: input.contactId,
        direction: 'out',
        sender: 'bot',
        text,
      }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
      if (!photoReserveError) {
        try {
          await sendAmoChatMessage({ chatId: input.chatId, leadId: input.leadId, contactId: input.contactId, text })
        } catch (error) {
          await supabase.from('amocrm_messages').delete().eq('amo_message_id', photoMessageId)
          console.error('amocrm bot-reply: results link send failed', error)
        }
      } else {
        console.error('amocrm bot-reply: results link reserve failed', photoReserveError.message)
      }
    }
    if (index < replies.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 900 + Math.random() * 500))
    }
  }

  // Ветки скрипта могут поднять этап дальше базовой эвристики (например
  // «order» после чек-листа оформления) — базовый inboundAction уже применён выше.
  if (stageAction) {
    const result = await advanceDealFromBotAction(externalKey, stageAction)
    if (!result.ok && result.error) {
      console.error('amocrm bot-reply: stage advance failed', stageAction, result.error)
    }
  }
}
