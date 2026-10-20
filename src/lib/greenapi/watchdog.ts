// Сторож бота: раз в минуту из followup-scheduler. Ничего не отправляет
// клиентам — только замечает проблемы и зовёт человека (Control Center + журнал):
//  • клиенты ждут ответа дольше 10 минут (бот/движок молчит);
//  • процесс CRM раздулся по памяти;
// и раз в час чистит журнал старше 3 суток.

import { createAdminClient } from '@/lib/supabase/admin'
import { recordEvent } from '@/lib/control-center'
import { logBotEvent, purgeOldBotEvents } from '@/lib/bot-log'
import { sendCriticalAlert } from '@/lib/alerts'
import { getGreenApiState } from '@/lib/greenapi/client'
import { findUnansweredChats } from '@/lib/greenapi/recovery'

const UNANSWERED_ALERT_MIN = 10
const UNANSWERED_ALERT_COUNT = 2
const ALERT_COOLDOWN_MS = 30 * 60_000
const MEMORY_ALERT_MB = 900
const MEMORY_COOLDOWN_MS = 30 * 60_000
const PURGE_EVERY_MS = 60 * 60_000
const UNANSWERED_CHECK_EVERY_MS = 5 * 60_000

let lastUnansweredAlert = 0
let lastMemoryAlert = 0
let lastPurge = 0
let lastUnansweredCheck = 0
let lastGreenApiCheck = 0
let greenApiBadChecks = 0
const GREEN_API_BAD_CHECKS_TO_ALERT = 3

export function memorySnapshot(): { rssMb: number; heapMb: number } {
  const usage = process.memoryUsage()
  return { rssMb: Math.round(usage.rss / 1048576), heapMb: Math.round(usage.heapUsed / 1048576) }
}

export async function runBotWatchdog(): Promise<void> {
  const now = Date.now()

  const memory = memorySnapshot()
  if (memory.rssMb > MEMORY_ALERT_MB && now - lastMemoryAlert > MEMORY_COOLDOWN_MS) {
    lastMemoryAlert = now
    logBotEvent({ channel: 'system', event: 'memory_high', level: 'warn', details: memory })
    recordEvent({ type: 'error', level: 'warning', title: 'CRM: высокое потребление памяти', payload: memory })
    sendCriticalAlert('memory-high', 'CRM съела много памяти', [`Занято ${memory.rssMb} МБ (порог ${MEMORY_ALERT_MB}). Возможен перезапуск сервиса.`])
  }

  if (now - lastPurge > PURGE_EVERY_MS) {
    lastPurge = now
    await purgeOldBotEvents()
  }

  if (now - lastGreenApiCheck > UNANSWERED_CHECK_EVERY_MS) {
    lastGreenApiCheck = now
    const state = await getGreenApiState().catch(() => 'недоступен')
    // Один таймаут или «starting» — перебой на стороне Green API, не повод будить
    // людей. Оповещаем, если плохо несколько проверок подряд.
    const healthy = state === 'authorized' || state === 'starting'
    const unreachable = state === 'недоступен'
    if (healthy && !unreachable) greenApiBadChecks = 0
    else greenApiBadChecks += 1
    if (!healthy || unreachable) {
      logBotEvent({ channel: 'system', event: 'green_api_state', level: 'warn', details: { state, badInRow: greenApiBadChecks } })
      if (greenApiBadChecks >= GREEN_API_BAD_CHECKS_TO_ALERT) {
        sendCriticalAlert(
          unreachable ? 'green-api-unreachable' : 'green-api-state',
          unreachable ? 'Green API не отвечает' : 'Green API: WhatsApp не авторизован',
          [`Состояние инстанса: ${state} (${greenApiBadChecks} проверок подряд). Бот может не писать клиентам.`]
        )
      }
    }
  }

  if (now - lastUnansweredCheck > UNANSWERED_CHECK_EVERY_MS) {
    lastUnansweredCheck = now
    const waiting = await findUnansweredChats(createAdminClient(), { minAgeMin: UNANSWERED_ALERT_MIN, hours: 6 })
    if (waiting.length >= UNANSWERED_ALERT_COUNT && now - lastUnansweredAlert > ALERT_COOLDOWN_MS) {
      lastUnansweredAlert = now
      logBotEvent({ channel: 'system', event: 'watchdog_unanswered', level: 'error', details: { chats: waiting.length, oldestMin: waiting[0]?.ageMin } })
      sendCriticalAlert('unanswered', `Клиенты ждут ответа дольше ${UNANSWERED_ALERT_MIN} минут`, [
        `Без ответа: ${waiting.length} чатов, самый старый ждёт ${waiting[0]?.ageMin} мин.`,
        'CRM → Настройки → WhatsApp → «Здоровье бота» → «Восстановить после сбоя».',
      ])
      recordEvent({
        type: 'error',
        level: 'error',
        title: 'WhatsApp: клиенты ждут ответа дольше 10 минут',
        payload: { chats: waiting.length, oldestMin: waiting[0]?.ageMin },
      })
    }
  }
}
