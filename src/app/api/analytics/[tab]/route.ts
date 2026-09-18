// GET /api/analytics/<вкладка>?period=<JSON PeriodInput> — данные вкладки
// «Аналитики».
//
// Раньше вкладки звали server actions. Действия со страницы выполняются
// строго по одному и после ответа могут перерисовать страницу; на проде
// 18.09 это закончилось бесконечным кругом: запрос ~10 с → перерисовка →
// тот же запрос заново, и вкладка навсегда оставалась на «Считаем лиды…».
// Обычный GET не стоит в общей очереди и страницу не трогает.

import { NextResponse, type NextRequest } from 'next/server'
import { isFailure, requireManagement } from '@/lib/auth-guards'
import { resolvePeriod, type PeriodInput } from '@/lib/analytics/period'
import {
  loadBotHandoff, loadCampaigns, loadFunnel, loadLeads, loadPurchases, loadStaff,
} from '@/lib/analytics/load'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const LOADERS = {
  leads: loadLeads,
  purchases: loadPurchases,
  staff: loadStaff,
  bot: loadBotHandoff,
  funnel: loadFunnel,
  campaigns: loadCampaigns,
} as const

export async function GET(request: NextRequest, { params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params
  const load = LOADERS[tab as keyof typeof LOADERS]
  if (!load) return NextResponse.json({ error: 'Неизвестная вкладка' }, { status: 404 })

  // Admin-клиент в расчёте читает в обход RLS — роль проверяем здесь.
  const guard = await requireManagement()
  if (isFailure(guard)) return NextResponse.json({ error: guard.error }, { status: 403 })

  let period: PeriodInput
  try {
    period = JSON.parse(request.nextUrl.searchParams.get('period') ?? '{"kind":"today"}') as PeriodInput
  } catch {
    return NextResponse.json({ error: 'Неверный период' }, { status: 400 })
  }

  try {
    const data = await load(resolvePeriod(period))
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('analytics api failed', tab, error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Не удалось посчитать' }, { status: 500 })
  }
}
