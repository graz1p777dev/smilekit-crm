'use client'

import { useEffect, useState } from 'react'
import type { PeriodInput } from '@/lib/analytics/period'
import { recoverFromStaleAction } from '@/lib/stale-action'

/**
 * Данные вкладки по периоду: страница уже отрисована, цифры едут следом.
 * Ответ на устаревший период (пользователь успел переключить) выбрасывается.
 */
export function useAnalyticsData<T>(load: (period: PeriodInput) => Promise<T>, period: PeriodInput) {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null; loadedAt: string | null }>({
    key: '', data: null, error: null, loadedAt: null,
  })
  const key = JSON.stringify(period)

  useEffect(() => {
    let alive = true
    load(JSON.parse(key) as PeriodInput)
      .then((data) => { if (alive) setState({ key, data, error: null, loadedAt: new Date().toISOString() }) })
      .catch((err: unknown) => {
        if (!alive || recoverFromStaleAction(err)) return
        setState({ key, data: null, error: err instanceof Error ? err.message : 'Не удалось посчитать', loadedAt: null })
      })
    return () => { alive = false }
  }, [load, key])

  const fresh = state.key === key
  return {
    data: fresh ? state.data : null,
    error: fresh ? state.error : null,
    loading: !fresh,
    loadedAt: fresh ? state.loadedAt : null,
  }
}

/** Отметка времени для шапки: когда посчитано (или хотя бы получено). */
export interface Stamp {
  at: string
  kind: 'computed' | 'loaded'
}

/** Сообщает шапке страницы время расчёта текущей вкладки. */
export function useReportStamp(
  generatedAt: string | null | undefined,
  loadedAt: string | null,
  onStamp: ((stamp: Stamp | null) => void) | undefined,
) {
  useEffect(() => {
    if (!onStamp) return
    if (generatedAt) onStamp({ at: generatedAt, kind: 'computed' })
    else if (loadedAt) onStamp({ at: loadedAt, kind: 'loaded' })
    else onStamp(null)
  }, [generatedAt, loadedAt, onStamp])
}
