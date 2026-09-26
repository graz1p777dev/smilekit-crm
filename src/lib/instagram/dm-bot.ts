// Автоответ бота в личных сообщениях Instagram.
//
// Мозг тот же, что у WhatsApp-бота: /internal/lab Telegram-бота Smilekit
// (src/lib/smilekit-bot-api.ts) — одна база знаний, один промпт, одни цены.
// Отличается только транспорт (Graph API вместо Green API) и хранилище
// истории (instagram_messages вместо chat_messages).
//
// Перенесённые из WhatsApp правила: бот молчит, если чат ведёт живой
// менеджер; клиент из стоп-списка не получает ответов вообще; повторная
// доставка вебхука не порождает второй ответ; ИИ не имеет права выдумывать
// скидки. Чего в Instagram сознательно НЕТ — оформления заказа (чек-лист,
// QR, приём чека): там нет ни QR-оплаты, ни распознавания чеков, этим
// занимается менеджер.
//
// ВАЖНО: только серверный код — здесь service-role клиент Supabase.

import { createAdminClient } from '@/lib/supabase/admin'
import { upsertDealFromInbound } from '@/lib/deals/auto-create'
import { smilekitBotFetch, BOT_TIMEOUTS_MS } from '@/lib/smilekit-bot-api'
import { AI_IMPROVISED_DISCOUNT } from '@/lib/greenapi/bot-reply'
import { DEFAULT_PRODUCT_INFO } from '@/lib/greenapi/default-templates'
import { getInstagramBotSettings } from '@/lib/instagram/config'
import { sendInstagramMessage, fetchInstagramUserProfile } from '@/lib/instagram/messaging'
import { DM_AI_FAILURE_REPLY } from '@/lib/instagram/texts'
import {
  storeInboundMessage,
  storeOutboundMessage,
  type ParsedIncomingMessage,
} from '@/lib/instagram/webhook'

/** Ключ чата Instagram в общей таблице chat_control (там же живут номера WhatsApp). */
export function instagramChatId(igsid: string): string {
  return `ig:${igsid}`
}

/** Ключ клиента в deals.external_key — по нему держится идемпотентность сделки. */
export function instagramExternalKey(igsid: string): string {
  return `instagram:${igsid}`
}

export const MESSAGING_WINDOW_MS = 24 * 60 * 60_000

/**
 * Правило Meta: свободный текст можно отправить только в течение 24 часов
 * после последнего сообщения клиента. Обычно окно открыто (мы отвечаем на
 * только что пришедшее сообщение), но вебхук может доехать с многочасовой
 * задержкой после ретраев — тогда отправлять нельзя, Graph API откажет.
 */
export function isWithinMessagingWindow(lastClientMessageMs: number, nowMs: number): boolean {
  return nowMs - lastClientMessageMs < MESSAGING_WINDOW_MS
}

async function isOptedOut(admin: ReturnType<typeof createAdminClient>, igsid: string): Promise<boolean> {
  const { data } = await admin.from('instagram_opt_outs').select('igsid').eq('igsid', igsid).maybeSingle()
  return Boolean(data)
}

/**
 * Тот же смысл, что isManagerControllingChat для WhatsApp: чат «у менеджера»,
 * если в нём писал живой человек. Явная отметка в chat_control перекрывает
 * прошлые сообщения менеджера, но только до его следующего сообщения.
 */
export async function isManagerControllingInstagramChat(
  admin: ReturnType<typeof createAdminClient>,
  igsid: string
): Promise<boolean> {
  const [operatorResult, controlResult] = await Promise.all([
    admin
      .from('instagram_messages')
      .select('created_at')
      .eq('sender_igsid', igsid)
      .eq('sender', 'operator')
      .order('created_at', { ascending: false })
      .limit(1),
    admin.from('chat_control').select('bot_enabled, updated_at').eq('chat_id', instagramChatId(igsid)).maybeSingle(),
  ])

  const lastOperatorRow = (operatorResult.data as { created_at: string }[] | null)?.[0]
  const lastOperatorAt = lastOperatorRow ? new Date(lastOperatorRow.created_at).getTime() : null

  const control = controlResult.data as { bot_enabled: boolean; updated_at: string } | null
  if (!control) return lastOperatorAt !== null
  const overrideIsFresh = lastOperatorAt === null || new Date(control.updated_at).getTime() > lastOperatorAt
  if (overrideIsFresh) return !control.bot_enabled
  return true
}

interface HistoryItem {
  role: 'user' | 'assistant'
  content: string
}

async function loadHistory(
  admin: ReturnType<typeof createAdminClient>,
  igsid: string,
  excludeMid: string
): Promise<HistoryItem[]> {
  const { data } = await admin
    .from('instagram_messages')
    .select('mid, text, direction')
    .eq('sender_igsid', igsid)
    .order('created_at', { ascending: false })
    .limit(20)
  return ((data ?? []) as { mid: string; text: string; direction: string }[])
    .filter((row) => row.mid !== excludeMid)
    .filter((row) => row.text.trim().length > 0)
    .reverse()
    .map((row) => ({ role: row.direction === 'in' ? 'user' : 'assistant', content: row.text }))
}

/** Ответ ИИ: один повтор при недоступности бота (на таймауте повтор вреден — генерация ещё идёт). */
async function generateReply(message: string, history: HistoryItem[]): Promise<string[]> {
  let lab = await smilekitBotFetch<{ reply: string }>('/internal/lab', {
    method: 'POST',
    body: { message, history },
    timeoutMs: BOT_TIMEOUTS_MS.lab,
  })
  if (!lab.ok && lab.status !== 504) {
    console.error('instagram dm-bot: lab failed, retrying once', lab.error)
    lab = await smilekitBotFetch<{ reply: string }>('/internal/lab', {
      method: 'POST',
      body: { message, history },
      timeoutMs: BOT_TIMEOUTS_MS.lab,
    })
  }
  if (!lab.ok) {
    console.error('instagram dm-bot: lab failed after retry', lab.error)
    return [DM_AI_FAILURE_REPLY]
  }
  const parts = (lab.data.reply ?? '')
    .split(/<NEXT_MESSAGE>/i)
    .map((part) => part.trim())
    .filter(Boolean)

  // Живой баг WhatsApp-бота, перенесённый сюда заранее: ИИ сам предлагал
  // скидку, о которой клиент не спрашивал. Разрешены только две ступени и
  // только в ответ на «дорого» — иначе отдаём утверждённый текст о товаре.
  const clientAskedAboutPrice = /цена|цену|стоит|стоимост|скидк|дорого|сом/i.test(message)
  const historyMentionsPrice = history.some((item) => item.content.toLowerCase().includes('сом'))
  if (!clientAskedAboutPrice && !historyMentionsPrice && parts.some((part) => AI_IMPROVISED_DISCOUNT.test(part))) {
    return [DEFAULT_PRODUCT_INFO]
  }
  return parts
}

/**
 * Полная обработка одного входящего сообщения: сохранить, завести лид,
 * проверить все запреты и ответить. Ничего не бросает наружу — вебхук должен
 * отдать Meta 200 в любом случае.
 */
export async function handleInstagramInboundMessage(message: ParsedIncomingMessage): Promise<void> {
  const admin = createAdminClient()

  // Дубль вебхука: строка уже есть — значит, ответ на это сообщение уже
  // сгенерирован (или идёт прямо сейчас), второй слать нельзя. Проверяем до
  // всего остального, чтобы ретрай Meta не стоил ни запроса в Graph API, ни
  // вызова ИИ.
  const isNew = await storeInboundMessage(message)
  if (!isNew) return

  // Имя/ник — best-effort: без подключённого аккаунта вернётся null, и это
  // нормально, сделка заведётся с названием «Клиент из Instagram».
  const profile = await fetchInstagramUserProfile(message.senderIgsid)
  const authorName = profile?.name ?? profile?.username ?? null
  if (authorName) {
    await admin.from('instagram_messages').update({ author_name: authorName }).eq('mid', message.mid)
  }

  await upsertDealFromInbound({
    externalKey: instagramExternalKey(message.senderIgsid),
    source: 'instagram',
    customerName: profile?.name ?? null,
    customerUsername: profile?.username ?? null,
  })

  const settings = await getInstagramBotSettings()
  if (!settings.dmEnabled) return
  if (await isOptedOut(admin, message.senderIgsid)) return
  if (await isManagerControllingInstagramChat(admin, message.senderIgsid)) return
  if (!message.text.trim()) return

  const history = await loadHistory(admin, message.senderIgsid, message.mid)
  const replies = await generateReply(message.text, history)
  if (replies.length === 0) return

  for (let index = 0; index < replies.length; index++) {
    const text = replies[index]
    if (!isWithinMessagingWindow(message.timestampMs, Date.now())) {
      // Окно закрыто — не пытаемся отправить (Graph API всё равно откажет),
      // но помечаем это в журнале, чтобы менеджер видел неотвеченного клиента.
      await storeOutboundMessage({
        mid: `ig:window-closed:${message.mid}:${index}`,
        recipientIgsid: message.senderIgsid,
        text,
        status: 'window_closed',
      })
      return
    }
    try {
      const sent = await sendInstagramMessage({ recipientId: message.senderIgsid, text })
      await storeOutboundMessage({
        mid: sent.messageId,
        recipientIgsid: message.senderIgsid,
        text,
        status: 'sent',
      })
    } catch (error) {
      console.error('instagram dm-bot: send failed', error)
      await storeOutboundMessage({
        mid: `ig:failed:${message.mid}:${index}`,
        recipientIgsid: message.senderIgsid,
        text,
        status: 'failed',
      })
      return
    }
  }
}
