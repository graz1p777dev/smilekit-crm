'use server'

// Аналитика владельца — вход для страницы. Admin-клиент в расчёте читает в
// обход RLS, поэтому здесь в каждом действии — проверка роли; сам расчёт —
// src/lib/analytics/load.ts.

import { isFailure, requireManagement } from '@/lib/auth-guards'
import { resolvePeriod, type PeriodInput, type PeriodRange } from '@/lib/analytics/period'
import { loadClientProfile, type ClientProfile } from '@/lib/analytics/client-profile'
import {
  loadBotHandoff, loadCampaigns, loadFunnel, loadLeads, loadPurchases, loadStaff,
  type BotHandoffAnalytics, type CampaignStat, type FunnelAnalytics, type LeadsAnalytics,
  type PurchasesAnalytics, type StaffAnalytics,
} from '@/lib/analytics/load'

export type { ClientProfile, ServedGroup } from '@/lib/analytics/client-profile'
export type {
  BotHandoffAnalytics, CampaignStat, ChatRef, FunnelAnalytics, LeadsAnalytics, PurchasesAnalytics,
  ReplyGroup, StaffAnalytics, StaffRow, StaffWork, TypeClientRow, WaitingRow,
} from '@/lib/analytics/load'

async function guard(period: PeriodInput): Promise<PeriodRange> {
  const result = await requireManagement()
  if (isFailure(result)) throw new Error(result.error)
  return resolvePeriod(period)
}

export async function getLeadsAnalytics(period: PeriodInput): Promise<LeadsAnalytics> {
  return loadLeads(await guard(period))
}

export async function getPurchasesAnalytics(period: PeriodInput): Promise<PurchasesAnalytics> {
  return loadPurchases(await guard(period))
}

export async function getStaffAnalytics(period: PeriodInput): Promise<StaffAnalytics> {
  return loadStaff(await guard(period))
}

export async function getBotHandoffAnalytics(period: PeriodInput): Promise<BotHandoffAnalytics> {
  return loadBotHandoff(await guard(period))
}

export async function getFunnelAnalytics(period: PeriodInput): Promise<FunnelAnalytics> {
  return loadFunnel(await guard(period))
}

export async function getCampaignAnalytics(period: PeriodInput): Promise<{ range: PeriodRange; campaigns: CampaignStat[] }> {
  return loadCampaigns(await guard(period))
}

export async function getClientProfile(phone: string): Promise<ClientProfile | null> {
  const result = await requireManagement()
  if (isFailure(result)) return null
  const digits = String(phone ?? '').replace(/\D/g, '')
  if (digits.length < 9) return null
  return loadClientProfile(digits)
}
