// Периодический heartbeat в Control Center — тот же паттерн, что
// startCampaignScheduler/startFollowupScheduler/startAmoOutgoingPoller
// (src/instrumentation.ts): setInterval, защита от повторного старта флагом
// started, timer.unref() чтобы не держать процесс живым.

import { sendHeartbeat } from '@/lib/control-center'

const HEARTBEAT_INTERVAL_MS = 120_000
let started = false

function beat(): void {
  sendHeartbeat({
    status: 'ok',
    gitSha: process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || 'unknown',
    deploySource: process.env.RAILWAY_GIT_COMMIT_SHA ? 'github' : 'unknown',
    security: { envPresent: Object.keys(process.env) },
  })
}

export function startControlCenterHeartbeat(): void {
  if (started) return
  started = true
  console.log('control center heartbeat started')
  beat()
  setInterval(beat, HEARTBEAT_INTERVAL_MS).unref?.()
}
