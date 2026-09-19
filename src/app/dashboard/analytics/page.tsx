import { redirect } from 'next/navigation'
import { isFailure, requireAnalytics } from '@/lib/auth-guards'
import AnalyticsTabs from '@/components/analytics/AnalyticsTabs'

// Страница отдаётся сразу, БЕЗ ожидания расчёта.
//
// Цифры считают SQL-функции (supabase/migrations/048_real_analytics.sql) по
// выбранному периоду. Их запрашивает клиент и показывает скелет, пока они
// едут: раньше расчёт стоял в рендере, и страница обрывалась по таймауту.
export const dynamic = 'force-dynamic'

export default async function AnalyticsPage() {
  // Прямой заход по адресу — тоже закрыт, а не только пункт меню.
  const access = await requireAnalytics()
  if (isFailure(access)) redirect('/dashboard')
  return <AnalyticsTabs />
}
