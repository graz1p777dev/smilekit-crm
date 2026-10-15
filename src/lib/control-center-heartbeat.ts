// Периодический heartbeat в Control Center — тот же паттерн, что
// startCampaignScheduler/startFollowupScheduler/startAmoOutgoingPoller
// (src/instrumentation.ts): setInterval, защита от повторного старта флагом
// started, timer.unref() чтобы не держать процесс живым.

import { memorySnapshot } from '@/lib/greenapi/watchdog'
import { fetchPromptIfChanged, getRemotePrompt, sendHeartbeat } from '@/lib/control-center'

const HEARTBEAT_INTERVAL_MS = 120_000
let started = false

// Сначала подтягиваем промпт (ETag → 304, если не менялся), затем шлём
// heartbeat с promptVersionId — ACK для Prompt Studio, какую версию бот
// реально использует. fetchPromptIfChanged никогда не бросает.
async function beat(): Promise<void> {
  await fetchPromptIfChanged()
  sendHeartbeat({
    status: 'ok',
    gitSha: process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || 'unknown',
    deploySource: process.env.RAILWAY_GIT_COMMIT_SHA ? 'github' : 'unknown',
    details: memorySnapshot(),
    security: { envPresent: Object.keys(process.env) },
    promptVersionId: getRemotePrompt()?.versionId,
  })
}

export function startControlCenterHeartbeat(): void {
  if (started) return
  started = true
  console.log('control center heartbeat started')
  void beat()
  setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS).unref?.()
}
