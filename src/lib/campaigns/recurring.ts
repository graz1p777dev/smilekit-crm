// Автоматические рассылки: правило повторения само заводит обычную рассылку
// каждые N дней в заданное время.
//
// Отправкой занимается тот же планировщик, что и для ручных: здесь мы только
// создаём запись в campaigns с получателями. Благодаря этому у автоматической
// рассылки работают ровно те же прогресс, список получателей и остановка.

import { createAdminClient } from '@/lib/supabase/admin'
import { eligibleRecipientsForRun, type CampaignAudience } from '@/actions/campaigns'
import { voiceById } from '@/config/voice-messages'

/** Asia/Bishkek — круглый год UTC+6. */
const BISHKEK_OFFSET_MS = 6 * 3600_000

interface RecurringRow {
  id: string
  title: string
  message: string | null
  voice_id: string | null
  audience: CampaignAudience
  interval_days: number
  send_at_time: string
  window_days: number | null
  last_run_at: string | null
  created_by: string | null
}

/** Локальные «сегодня» и «сейчас» по Бишкеку. */
function bishkekNow() {
  return new Date(Date.now() + BISHKEK_OFFSET_MS)
}

/** Момент сегодняшнего запуска правила, в UTC. */
function todaysRunMoment(sendAtTime: string): Date {
  const local = bishkekNow()
  const [hours, minutes] = sendAtTime.split(':').map(Number)
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  return new Date(localMidnight + (hours * 60 + minutes) * 60_000 - BISHKEK_OFFSET_MS)
}

/** Дата (YYYY-MM-DD) по Бишкеку со сдвигом на N суток назад. */
function bishkekDay(daysAgo = 0): string {
  return new Date(bishkekNow().getTime() - daysAgo * 86400_000).toISOString().slice(0, 10)
}

function shouldRun(rule: RecurringRow, now: Date): boolean {
  const moment = todaysRunMoment(rule.send_at_time)
  // Время сегодняшнего запуска ещё не наступило.
  if (now.getTime() < moment.getTime()) return false
  // Уже отрабатывало сегодня.
  if (rule.last_run_at && new Date(rule.last_run_at).getTime() >= moment.getTime()) return false
  // Период: между запусками должно пройти не меньше interval_days суток.
  if (rule.last_run_at) {
    const daysSince = (moment.getTime() - new Date(rule.last_run_at).getTime()) / 86400_000
    if (daysSince < rule.interval_days - 0.5) return false
  }
  return true
}

/**
 * Создаёт рассылки по всем правилам, которым пора. Вызывается из тика
 * планировщика; ошибки одного правила не мешают остальным.
 */
export async function runDueRecurringCampaigns(): Promise<void> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('recurring_campaigns')
    .select('id, title, message, voice_id, audience, interval_days, send_at_time, window_days, last_run_at, created_by')
    .eq('is_active', true)
    .is('deleted_at', null)

  // Таблицы может ещё не быть (миграция 045) — это не повод шуметь каждые
  // 30 секунд и тем более ронять планировщик обычных рассылок.
  if (error || !data?.length) return

  const now = new Date()
  for (const rule of data as RecurringRow[]) {
    if (!shouldRun(rule, now)) continue
    try {
      await launch(rule)
    } catch (launchError) {
      console.error(
        `recurring campaign ${rule.id}: не удалось запустить —`,
        launchError instanceof Error ? launchError.message : launchError
      )
    }
  }
}

async function launch(rule: RecurringRow): Promise<void> {
  const admin = createAdminClient()

  // Отметку ставим ДО создания рассылки: если что-то упадёт посередине,
  // следующий тик (через 30 секунд) не создаст рассылку повторно.
  await admin
    .from('recurring_campaigns')
    .update({ last_run_at: new Date().toISOString() })
    .eq('id', rule.id)

  const window = rule.window_days
  const recipients = await eligibleRecipientsForRun({
    audience: rule.audience,
    from: window ? bishkekDay(window - 1) : undefined,
    to: window ? bishkekDay(0) : undefined,
  })
  if (!recipients.length) {
    console.error(`recurring campaign ${rule.id}: под фильтры не попал никто, пропускаем`)
    return
  }

  const voice = voiceById(rule.voice_id)
  const { data: campaign, error } = await admin
    .from('campaigns')
    .insert({
      title: rule.title,
      message: rule.message,
      ...(voice ? { voice_id: voice.id } : {}),
      recurring_id: rule.id,
      scheduled_at: new Date().toISOString(),
      recipient_count: recipients.length,
      created_by: rule.created_by,
    })
    .select('id')
    .single()
  if (error || !campaign) throw new Error(error?.message ?? 'не удалось создать рассылку')

  const { error: recipientError } = await admin
    .from('campaign_recipients')
    .insert(recipients.map((row) => ({ ...row, campaign_id: (campaign as { id: string }).id })))
  if (recipientError) {
    await admin.from('campaigns').delete().eq('id', (campaign as { id: string }).id)
    throw new Error(recipientError.message)
  }
}
