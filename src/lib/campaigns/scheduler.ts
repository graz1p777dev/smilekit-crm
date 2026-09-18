import { sendGreenApiMessage, sendGreenApiVoice, toGreenApiChatId } from '@/lib/greenapi/client'
import { smilekitBotFetch } from '@/lib/smilekit-bot-api'
import { createAdminClient } from '@/lib/supabase/admin'
import { runDueRecurringCampaigns } from './recurring'
import { eligibleRecipientsForRun, type AudienceFilter } from '@/actions/campaigns'
import { voiceById, type VoiceMessage } from '@/config/voice-messages'

/**
 * Голосовое Green API забирает САМ по ссылке, поэтому она должна быть
 * публичной и абсолютной. Домен берём из Railway, иначе из явной переменной.
 */
function voiceUrl(voice: VoiceMessage): string {
  const host = process.env.PUBLIC_APP_URL || process.env.RAILWAY_PUBLIC_DOMAIN
  if (!host) throw new Error('Не задан публичный адрес CRM — голосовое отправить не по чему')
  const base = host.startsWith('http') ? host : `https://${host}`
  return `${base}/voice/${voice.file}`
}

const POLL_INTERVAL_MS = 30_000
// Green API — это мост к WhatsApp Web, а не официальный Business API: слишком
// плотная массовая отправка с одного номера повышает риск блокировки самим
// WhatsApp. 3 секунды между сообщениями — компромисс между скоростью и риском
// (1000 адресатов ≈ 50 минут).
const SEND_INTERVAL_MS = 3_000
let started = false

// voice_id помечен необязательным намеренно: пока миграция 042 не применена,
// такой колонки в базе нет и в строке её просто не будет.
type Campaign = { id: string; message: string | null; voice_id?: string | null }
type Recipient = {
  id: number
  channel: 'telegram' | 'whatsapp' | 'instagram'
  chat_id: string
  lead_id: string | null
  contact_id: string | null
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function recoverInterruptedCampaigns() {
  const admin = createAdminClient()
  const { data: running } = await admin.from('campaigns').select('id').eq('status', 'running')
  const ids = (running ?? []).map((row) => row.id)
  if (!ids.length) return
  await admin
    .from('campaign_recipients')
    .update({ status: 'failed', error: 'Отправка прервана перезапуском сервиса' })
    .in('campaign_id', ids)
    .eq('status', 'sending')
  await admin.from('campaigns').update({ status: 'scheduled' }).in('id', ids)
}

async function send(recipient: Recipient, campaign: Campaign) {
  const voice = voiceById(campaign.voice_id)
  // В историю чата и в Telegram уходит текст; для голосовой рассылки без
  // текста подписываем её названием — иначе в переписке будет пустая строка.
  const text = campaign.message?.trim() || (voice ? `🎤 ${voice.label}` : '')

  if (recipient.channel === 'telegram') {
    // Голосовые пока умеет только WhatsApp (Green API). В Telegram у бота
    // своя ручка broadcast, и она принимает текст — шлём подпись.
    const result = await smilekitBotFetch<{ ok: true }>(
      `/internal/chats/${encodeURIComponent(recipient.chat_id)}/broadcast`,
      { method: 'POST', body: { text } }
    )
    if (!result.ok) throw new Error(result.error)
    return
  }
  // Записываем ДО отправки как своё сообщение: иначе исходящее эхо из вебхука
  // amoCRM не опознаётся (registerOutgoingAmoMessage ищет свежую строку с
  // sender='bot' и тем же текстом) и рассылка выглядит как «менеджер вступил
  // в диалог» — бот после этого замолкает в чате навсегда, а чат выпадает из
  // аудитории следующих рассылок.
  const admin = createAdminClient()
  await admin.from('chat_messages').upsert({
    amo_message_id: `campaign:${campaign.id}:${recipient.id}`,
    chat_id: recipient.chat_id,
    lead_id: recipient.lead_id,
    contact_id: recipient.contact_id,
    direction: 'out',
    sender: 'bot',
    text,
  }, { onConflict: 'amo_message_id', ignoreDuplicates: true })
  // Только цифры в chat_id — это номер телефона, значит адресат подобран под
  // Green API (см. eligibleRecipients). UUID-подобный chat_id — старый путь
  // через amojo для чатов, у которых есть переписка в amoCRM.
  if (/^\d{9,}$/.test(recipient.chat_id)) {
    const chatId = toGreenApiChatId(recipient.chat_id)
    if (voice) {
      await sendGreenApiVoice(chatId, voiceUrl(voice), voice.file)
      // Текст рядом с голосовым шлём, только если менеджер его написал:
      // подпись-заглушка клиенту не нужна.
      if (campaign.message?.trim()) await sendGreenApiMessage(chatId, campaign.message.trim())
      return
    }
    await sendGreenApiMessage(chatId, text)
    return
  }
  // Канал один — Green API, он адресуется номером. Получатель без номера
  // (старый чат amoCRM) теперь недостижим — помечаем ошибкой, а не делаем
  // вид, что отправили.
  throw new Error('У получателя нет номера — отправить через WhatsApp нечем')
}

async function finishCampaign(campaignId: string) {
  const admin = createAdminClient()
  const { data } = await admin
    .from('campaign_recipients')
    .select('status')
    .eq('campaign_id', campaignId)
  const sent = (data ?? []).filter((row) => row.status === 'sent').length
  const failed = (data ?? []).filter((row) => ['failed', 'skipped'].includes(row.status)).length
  await admin.from('campaigns').update({
    status: sent > 0 || failed === 0 ? 'completed' : 'failed',
    sent_count: sent,
    failed_count: failed,
    completed_at: new Date().toISOString(),
  }).eq('id', campaignId)
}

async function processCampaign(campaign: Campaign) {
  const admin = createAdminClient()
  const { data } = await admin
    .from('campaign_recipients')
    .select('id, channel, chat_id, lead_id, contact_id')
    .eq('campaign_id', campaign.id)
    .eq('status', 'pending')
    .order('id')

  let sentSoFar = 0
  let failedSoFar = 0

  for (const recipient of (data ?? []) as Recipient[]) {
    // Между сообщениями сверяемся со статусом: рассылку могли отменить уже
    // после старта, и продолжать отправку в этом случае нельзя.
    const { data: current } = await admin
      .from('campaigns')
      .select('status')
      .eq('id', campaign.id)
      .maybeSingle()
    if ((current as { status?: string } | null)?.status === 'cancelled') return

    const { data: claimed } = await admin
      .from('campaign_recipients')
      .update({ status: 'sending', error: null })
      .eq('id', recipient.id)
      .eq('status', 'pending')
      .select('id')
    if (!claimed?.length) continue
    try {
      await send(recipient, campaign)
      await admin.from('campaign_recipients').update({
        status: 'sent',
        sent_at: new Date().toISOString(),
      }).eq('id', recipient.id)
      sentSoFar += 1
      // Счётчик в карточке рассылки двигаем ПО ХОДУ дела. Раньше он писался
      // только в finishCampaign, то есть в самом конце: всю отправку карточка
      // показывала «0 из 118», и рабочая рассылка выглядела зависшей.
      await admin
        .from('campaigns')
        .update({ sent_count: sentSoFar, failed_count: failedSoFar })
        .eq('id', campaign.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка отправки'
      await admin.from('campaign_recipients').update({
        status: 'failed',
        error: message.slice(0, 500),
      }).eq('id', recipient.id)
      failedSoFar += 1
      await admin
        .from('campaigns')
        .update({ sent_count: sentSoFar, failed_count: failedSoFar })
        .eq('id', campaign.id)
      console.error(`campaign ${campaign.id}: отправка ${recipient.chat_id} не удалась — ${message}`)
    }
    await delay(SEND_INTERVAL_MS)
  }
  await finishCampaign(campaign.id)
}

async function poll() {
  const admin = createAdminClient()
  const { data } = await admin
    .from('campaigns')
    .select('*')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at')
    .limit(1)
    .maybeSingle()
  if (!data) return
  const { data: claimed } = await admin
    .from('campaigns')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', data.id)
    .eq('status', 'scheduled')
    .select('*')
    .maybeSingle()
  if (!claimed) return
  const refreshFilter = (claimed as { refresh_filter?: AudienceFilter | null }).refresh_filter
  if (refreshFilter) await refreshRecipients(claimed.id as string, refreshFilter)
  await processCampaign(claimed as Campaign)
}

/**
 * Рассылка «С прошлой рассылки» берёт клиентов, писавших до времени
 * отправки. При создании список был только «на тот момент» — теперь, когда
 * время пришло, подбираем заново тем же фильтром (те же правила: купившие,
 * стоп-список, менеджер в переписке, уже получившие сегодня).
 *
 * Пересчёт — РОВНО ОДИН РАЗ. Живой инцидент 18.09: сервер перезапустился
 * посреди отправки (деплой), рассылка стартовала заново, пересчёт удалил 237
 * ещё не отправленных, а новый список не записался — он пересёкся с уже
 * отправленными (UNIQUE campaign_id+deal_id), и рассылка закрылась на 130/367.
 * Поэтому: фильтр снимается сразу после пересчёта, а тех, кто уже есть в
 * рассылке (в любом статусе), повторно не добавляем.
 */
async function refreshRecipients(campaignId: string, filter: AudienceFilter) {
  const admin = createAdminClient()
  const recipients = await eligibleRecipientsForRun(filter)
  const { data: kept } = await admin
    .from('campaign_recipients')
    .select('deal_id')
    .eq('campaign_id', campaignId)
    .neq('status', 'pending')
  const keptDeals = new Set(((kept ?? []) as { deal_id: string }[]).map((row) => String(row.deal_id)))
  const fresh = recipients.filter((row) => !keptDeals.has(String(row.deal_id)))

  // Сначала новый список, потом удаление старого ожидающего: если вставка не
  // удастся, старые получатели останутся в очереди, а не пропадут.
  await admin.from('campaign_recipients').update({ status: 'skipped', error: 'пересчёт получателей' })
    .eq('campaign_id', campaignId).eq('status', 'pending')
  if (fresh.length) {
    const { error } = await admin
      .from('campaign_recipients')
      .upsert(fresh.map((row) => ({ ...row, campaign_id: campaignId, status: 'pending', error: null })), {
        onConflict: 'campaign_id,deal_id',
      })
    if (error) {
      console.error('campaign refresh recipients failed', campaignId, error.message)
      await admin.from('campaign_recipients').update({ status: 'pending', error: null })
        .eq('campaign_id', campaignId).eq('status', 'skipped').eq('error', 'пересчёт получателей')
      await admin.from('campaigns').update({ refresh_filter: null }).eq('id', campaignId)
      return
    }
  }
  await admin.from('campaign_recipients').delete()
    .eq('campaign_id', campaignId).eq('status', 'skipped').eq('error', 'пересчёт получателей')
  await admin.from('campaigns')
    .update({ recipient_count: keptDeals.size + fresh.length, refresh_filter: null })
    .eq('id', campaignId)
}

export function startCampaignScheduler() {
  if (started) return
  started = true
  void recoverInterruptedCampaigns()
    .then(poll)
    .catch((error) => console.error('campaign scheduler recovery failed', error))
  const timer = setInterval(() => {
    // Сначала правила автоматических рассылок — они создают обычные записи,
    // которые тем же тиком и подхватываются на отправку.
    void runDueRecurringCampaigns()
      .catch((error) => console.error('recurring campaigns failed', error))
      .then(() => poll())
      .catch((error) => console.error('campaign scheduler failed', error))
  }, POLL_INTERVAL_MS)
  timer.unref?.()
}
