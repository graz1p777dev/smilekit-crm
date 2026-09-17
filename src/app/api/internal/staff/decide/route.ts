import { NextResponse } from 'next/server'
import { decideShiftRequest, staffByTelegram } from '@/lib/staff/service'
import { badRequest, notLoggedIn, readBody, rejectUnauthorized } from '../_shared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  const denied = rejectUnauthorized(request)
  if (denied) return denied
  const parsed = await readBody(request)
  const requestId = parsed?.body.requestId
  const decision = parsed?.body.decision
  if (!parsed || typeof requestId !== 'string' || (decision !== 'approve' && decision !== 'reject')) {
    return badRequest()
  }
  const staff = await staffByTelegram(parsed.telegramId)
  if (!staff) return notLoggedIn()

  const result = await decideShiftRequest(requestId, { kind: 'staff', staffId: staff.id }, decision)
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status })
  return NextResponse.json(result)
}
