import AnalyticsTabs from '@/components/analytics/AnalyticsTabs'

// Страница отдаётся сразу, БЕЗ ожидания расчёта.
//
// getConversionAnalytics() перебирает переписку за год (десятки тысяч строк,
// постранично по 1000). Пока это стояло в рендере, открытие «Аналитики»
// ждало весь перебор и часто не дожидалось — ровно та же поломка, что была
// у «Рассылок»: соединение рвётся, пользователь видит бесконечный логотип.
// Теперь цифры запрашивает клиент и показывает скелет, пока они едут.
export const dynamic = 'force-dynamic'

export default function AnalyticsPage() {
  return <AnalyticsTabs />
}
