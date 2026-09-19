// Загрузка вкладок «Аналитики» из браузера — через GET /api/analytics/<вкладка>,
// а не server actions (почему — см. src/app/api/analytics/[tab]/route.ts).
// Имена и типы те же, что были у действий, поэтому компонентам достаточно
// поменять путь импорта.

import type { PeriodInput, PeriodRange } from './period'
import type {
  AdSourceAnalytics, AlmostBoughtAnalytics, BotFunnelAnalytics, BotHandoffAnalytics, CampaignStat, CitiesAnalytics,
  DiscountAnalytics, FunnelAnalytics, LeadsAnalytics, LoadAnalytics, PurchasesAnalytics, ReceiptsAnalytics,
  ReturningAnalytics, StaffAnalytics, StaffSpeedRow,
} from './load'

export type {
  AdSourceAnalytics, AlmostBoughtAnalytics, AlmostRow, BotFunnelAnalytics, BotHandoffAnalytics, BoughtGroup, CampaignStat,
  ChatRef, CitiesAnalytics, CityRow, DiscountAnalytics, FunnelAnalytics, LeadsAnalytics, LoadAnalytics, LoadHour,
  PurchasesAnalytics, ReadySignal, ReceiptKind, ReceiptsAnalytics, ReplyGroup, ReturningAnalytics, StaffAnalytics,
  StaffRow, StaffSpeedRow, StaffWork, TypeClientRow, WaitingRow,
} from './load'

/** Дольше этого ждать бессмысленно: самый тяжёлый расчёт («Лиды» за всё время) идёт ~7 с. */
const TIMEOUT_MS = 45_000

async function fetchTab<T>(tab: string, period: PeriodInput): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/analytics/${tab}?period=${encodeURIComponent(JSON.stringify(period))}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(error instanceof Error && error.name === 'TimeoutError'
      ? 'Сервер считает слишком долго — попробуйте ещё раз'
      : 'Нет связи с сервером')
  }
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null
  if (!response.ok || !body) throw new Error(body?.error ?? `Ошибка сервера (${response.status})`)
  return body
}

export const getLeadsAnalytics = (period: PeriodInput) => fetchTab<LeadsAnalytics>('leads', period)
export const getPurchasesAnalytics = (period: PeriodInput) => fetchTab<PurchasesAnalytics>('purchases', period)
export const getStaffAnalytics = (period: PeriodInput) => fetchTab<StaffAnalytics>('staff', period)
export const getBotHandoffAnalytics = (period: PeriodInput) => fetchTab<BotHandoffAnalytics>('bot', period)
export const getFunnelAnalytics = (period: PeriodInput) => fetchTab<FunnelAnalytics>('funnel', period)
export const getCampaignAnalytics = (period: PeriodInput) =>
  fetchTab<{ range: PeriodRange; campaigns: CampaignStat[] }>('campaigns', period)
export const getAlmostBoughtAnalytics = (period: PeriodInput) => fetchTab<AlmostBoughtAnalytics>('almost', period)
export const getBotFunnelAnalytics = (period: PeriodInput) => fetchTab<BotFunnelAnalytics>('botfunnel', period)
export const getAdSourceAnalytics = (period: PeriodInput) => fetchTab<AdSourceAnalytics>('adsource', period)
export const getDiscountAnalytics = (period: PeriodInput) => fetchTab<DiscountAnalytics>('discounts', period)
export const getLoadAnalytics = (period: PeriodInput) => fetchTab<LoadAnalytics>('load', period)
export const getCitiesAnalytics = (period: PeriodInput) => fetchTab<CitiesAnalytics>('cities', period)
export const getReceiptsAnalytics = (period: PeriodInput) => fetchTab<ReceiptsAnalytics>('receipts', period)
export const getReturningAnalytics = (period: PeriodInput) => fetchTab<ReturningAnalytics>('returning', period)
export const getStaffSpeedAnalytics = (period: PeriodInput) =>
  fetchTab<{ range: PeriodRange; staff: StaffSpeedRow[] }>('staffspeed', period)
