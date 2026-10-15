// Критические ошибки бота — сообщением людям, а не только в журнал:
//  • Telegram-группа (та же, куда падают заказы; ALERT_TELEGRAM_BOT_TOKEN +
//    ALERT_TELEGRAM_CHAT_ID);
//  • WhatsApp-группа менеджеров («Передача от бота», запасной вариант —
//    группа доставки) через Green API.
// Каналы независимы: если упал Green API, Telegram всё равно дойдёт.
// Один и тот же сигнал не чаще раза в 30 минут. Ничего не бросает наружу.

import { getWhatsappBotConfig } from '@/lib/greenapi/config'
import { sendGreenApiDeliveryGroup } from '@/lib/greenapi/client'
import { logBotEvent } from '@/lib/bot-log'

const COOLDOWN_MS = 30 * 60_000
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

/** key — вид сигнала для подавления повторов; text — что увидят люди. */
export function sendCriticalAlert(key: string, title: string, lines: string[] = []): void {
  const now = Date.now()
  if (now - (lastSent.get(key) ?? 0) < COOLDOWN_MS) return
  lastSent.set(key, now)
  const text = [`🚨 SmileKit: ${title}`, ...lines, `Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Bishkek' })}`].join('\n')
  void (async () => {
    const results = await Promise.allSettled([sendTelegram(text), sendWhatsAppGroup(text)])
    const sent = results.map((r) => r.status === 'fulfilled' && r.value)
    logBotEvent({
      channel: 'system',
      event: 'critical_alert',
      level: sent.some(Boolean) ? 'warn' : 'error',
      details: { key, title, telegram: sent[0], whatsapp: sent[1] },
    })
  })()
}
