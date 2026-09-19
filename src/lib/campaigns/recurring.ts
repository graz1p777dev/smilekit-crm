// Автоматические рассылки: правило повторения само заводит обычную рассылку
// каждые N дней в заданное время.
//
// Отправкой занимается тот же планировщик, что и для ручных: здесь мы только
// создаём запись в campaigns с получателями. Благодаря этому у автоматической
// рассылки работают ровно те же прогресс, список получателей и остановка.

import { createAdminClient } from '@/lib/supabase/admin'
import { eligibleRecipientsForRun, type CampaignAudience } from '@/actions/campaigns'
import { voiceById } from '@/config/voice-messages'
import { recurringAudienceFilter, type RecurringPeriodMode } from './recurring-filter'

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
  period_mode: RecurringPeriodMode
  from_date: string | null
  include_manager_chats: boolean
  skip_reached_today: boolean
  last_run_at: string | null
  created_by: string | null
  audience_estimated_at: string | null
}

const RULE_COLUMNS = 'id, title, message, voice_id, audience, interval_days, send_at_time, window_days, period_mode, ' +
  'from_date, include_manager_chats, skip_reached_today, last_run_at, created_by, audience_estimated_at'

/** Оценку аудитории пересчитываем примерно раз в сутки. */
const ESTIMATE_TTL_MS = 24 * 3600_000

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
    .select(RULE_COLUMNS)
    .eq('is_active', true)
    .is('deleted_at', null)

  // Таблицы может ещё не быть (миграция 045) — это не повод шуметь каждые
  // 30 секунд и тем более ронять планировщик обычных рассылок.
  if (error || !data?.length) return

  const now = new Date()
  for (const rule of data as unknown as RecurringRow[]) {
    if (shouldRun(rule, now)) {
      try {
        await launch(rule)
      } catch (launchError) {
        console.error(
          `recurring campaign ${rule.id}: не удалось запустить —`,
          launchError instanceof Error ? launchError.message : launchError
        )
      }
      continue
    }
    // Раз в сутки обновляем оценку «сколько человек получат», чтобы число
    // в карточке правила не устаревало, даже если на страницу не заходят.
    const estimatedAt = rule.audience_estimated_at ? new Date(rule.audience_estimated_at).getTime() : 0
    if (now.getTime() - estimatedAt >= ESTIMATE_TTL_MS) {
      await estimateRecurringAudience(rule.id).catch((error) =>
        console.error(`recurring campaign ${rule.id}: оценка аудитории не удалась`, error))
    }
  }
}

/** Когда создана последняя неотменённая рассылка — начало периода «с прошлой рассылки». */
async function lastCampaignAt(): Promise<string | null> {
  const { data } = await createAdminClient()
    .from('campaigns')
    .select('created_at')
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { created_at?: string } | null)?.created_at ?? null
}

/**
 * Считает, сколько человек получили бы рассылку правила прямо сейчас, и
 * запоминает число. Правила те же, что при реальной отправке.
 */
export async function estimateRecurringAudience(ruleId: string): Promise<number | null> {
  const admin = createAdminClient()
  const { data } = await admin.from('recurring_campaigns').select(RULE_COLUMNS).eq('id', ruleId).maybeSingle()
  const rule = data as unknown as RecurringRow | null
  if (!rule) return null
  const filter = recurringAudienceFilter(rule, Date.now(), await lastCampaignAt())
  const count = filter ? (await eligibleRecipientsForRun(filter)).length : 0
  await admin.from('recurring_campaigns')
    .update({ audience_estimate: count, audience_estimated_at: new Date().toISOString() })
    .eq('id', ruleId)
  return count
}

async function launch(rule: RecurringRow): Promise<void> {
  const admin = createAdminClient()

  // Отметку ставим ДО создания рассылки: если что-то упадёт посередине,
  // следующий тик (через 30 секунд) не создаст рассылку повторно.
  await admin
    .from('recurring_campaigns')
    .update({ last_run_at: new Date().toISOString() })
    .eq('id', rule.id)

  const filter = recurringAudienceFilter(rule, Date.now(), await lastCampaignAt())
  if (!filter) {
    console.error(`recurring campaign ${rule.id}: прошлых рассылок нет — период «с прошлой рассылки» не от чего считать`)
    return
  }
  const recipients = await eligibleRecipientsForRun(filter)
  await admin.from('recurring_campaigns')
    .update({ audience_estimate: recipients.length, audience_estimated_at: new Date().toISOString() })
    .eq('id', rule.id)
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
