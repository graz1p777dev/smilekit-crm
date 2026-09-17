import { NextResponse } from 'next/server'
import { getStaffState, staffByTelegram } from '@/lib/staff/service'
import { badRequest, readBody, rejectUnauthorized } from '../_shared'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  const denied = rejectUnauthorized(request)
  if (denied) return denied
  const parsed = await readBody(request)
  if (!parsed) return badRequest()
  const staff = await staffByTelegram(parsed.telegramId)
  return NextResponse.json({ ok: true, ...(await getStaffState(staff)) })
}
