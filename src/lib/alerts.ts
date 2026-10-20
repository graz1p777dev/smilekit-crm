// Критические ошибки бота — сообщением людям, а не только в журнал:
//  • Telegram-группа (та же, куда падают заказы; ALERT_TELEGRAM_BOT_TOKEN +
//    ALERT_TELEGRAM_CHAT_ID);
//  • WhatsApp-группа менеджеров («Передача от бота», запасной вариант —
//    группа доставки) через Green API.
// Каналы независимы: если упал Green API, Telegram всё равно дойдёт.
// Один и тот же сигнал — не чаще раза в сутки (решение владельца 20.10), даже после
// перезапуска сервиса: прошлые оповещения читаются из журнала. Другой сигнал
// (другой key) уходит сразу. Ничего не бросает наружу.

import { getWhatsappBotConfig } from '@/lib/greenapi/config'
import { sendGreenApiDeliveryGroup } from '@/lib/greenapi/client'
import { logBotEvent } from '@/lib/bot-log'
import { createAdminClient } from '@/lib/supabase/admin'

const COOLDOWN_MS = 24 * 60 * 60_000
const lastSent = new Map<string, number>()

async function sendTelegram(text: string): Promise<boolean> {
  const token = process.env.ALERT_TELEGRAM_BOT_TOKEN
  const chatId = process.env.ALERT_TELEGRAM_CHAT_ID
  if (!token || !chatId) return false
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10_000),
  })
  return response.ok
}

async function sendWhatsAppGroup(text: string): Promise<boolean> {
  const config = await getWhatsappBotConfig()
  return sendGreenApiDeliveryGroup(config.handoffGroupId ?? config.deliveryGroupId, text)
}

/** Был ли такой сигнал уже отправлен за последние сутки (переживает перезапуск). */
async function alreadySentToday(key: string): Promise<boolean> {
  try {
    const { data } = await createAdminClient()
      .from('bot_event_log')
      .select('id')
      .eq('event', 'critical_alert')
      .eq('details->>key', key)
      .gte('created_at', new Date(Date.now() - COOLDOWN_MS).toISOString())
      .limit(1)
    return Boolean(data?.length)
  } catch {
    return false
  }
}

/** key — вид сигнала для подавления повторов; text — что увидят люди. */
/**
 * Сигналы о проблемах самого WhatsApp (Green API) в WhatsApp-группу не шлём:
 * канал сломан, сообщение либо не дойдёт, либо придёт с опозданием и только
 * запутает. Для них — только Telegram.
 */
function isWhatsAppProblem(key: string): boolean {
  return key.startsWith('green-api')
}

export function sendCriticalAlert(key: string, title: string, lines: string[] = []): void {
  const now = Date.now()
  if (now - (lastSent.get(key) ?? 0) < COOLDOWN_MS) return
  lastSent.set(key, now)
  const text = [`🚨 SmileKit: ${title}`, ...lines, `Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Bishkek' })}`].join('\n')
  void (async () => {
    if (await alreadySentToday(key)) return
    const results = await Promise.allSettled([
      sendTelegram(text),
      isWhatsAppProblem(key) ? Promise.resolve(false) : sendWhatsAppGroup(text),
    ])
    const sent = results.map((r) => r.status === 'fulfilled' && r.value)
    logBotEvent({
      channel: 'system',
      event: 'critical_alert',
      level: sent.some(Boolean) ? 'warn' : 'error',
      details: { key, title, telegram: sent[0], whatsapp: sent[1] },
    })
  })()
}
