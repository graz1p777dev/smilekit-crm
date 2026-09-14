'use client'

// Общие детали оформления аналитики.
//
// Палитра проверена валидатором dataviz (светлая поверхность): все пары
// различимы при дальтонизме и дают контраст выше 3:1. Фирменный #5115a4 для
// графиков слишком тёмный (выпадает из полосы светлоты), поэтому в марках
// используется его более светлый родственник #7c3aed, а сам бренд остаётся
// в заголовках и кнопках.
export const SERIES = ['#7c3aed', '#0d9488', '#ea580c'] as const

/** Один тон, светлый → тёмный: для «больше/меньше», а не для «разное». */
export const SEQ = ['#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed'] as const

export const INK = '#17102a'
export const INK_2 = '#4e4560'
export const INK_3 = '#766d88'
export const LINE = '#ece5e5'

export const money = (value: number) => `${Math.round(value).toLocaleString('ru-RU')} сом`
export const num = (value: number) => value.toLocaleString('ru-RU')

export function Card({
  title,
  hint,
  children,
  wide,
}: {
  title: string
  hint?: string
  children: React.ReactNode
  wide?: boolean
}) {
  return (
    <section
      className={`rounded-2xl bg-white p-5 ${wide ? 'md:col-span-2' : ''}`}
      style={{ border: `1px solid ${LINE}` }}
    >
      <h2 className="text-sm font-semibold" style={{ color: INK }}>{title}</h2>
      {hint && <p className="mt-0.5 text-xs" style={{ color: INK_3 }}>{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

/** Крупное число — когда показатель один и график ему не нужен. */
export function Stat({
  label,
  value,
  sub,
  tone = 'brand',
}: {
  label: string
  value: string
  sub?: string
  tone?: 'brand' | 'good' | 'warn'
}) {
  const color = tone === 'good' ? '#047857' : tone === 'warn' ? '#c2410c' : '#5115a4'
  return (
    <div className="rounded-2xl bg-white px-4 py-3.5" style={{ border: `1px solid ${LINE}` }}>
      <div className="text-[22px] font-bold leading-tight tabular-nums" style={{ color }}>{value}</div>
      <div className="mt-0.5 text-xs" style={{ color: INK_2 }}>{label}</div>
      {sub && <div className="mt-0.5 text-[11px]" style={{ color: INK_3 }}>{sub}</div>}
    </div>
  )
}

/**
 * Горизонтальные полосы. Одна серия — значит один тон: длина полосы уже
 * кодирует величину, разные цвета здесь были бы ложным вторым смыслом.
 */
export function Bars({
  items,
  max,
}: {
  items: { label: string; value: number; hint?: string }[]
  max?: number
}) {
  if (items.length === 0) {
    return <p className="text-sm" style={{ color: INK_3 }}>Нет данных</p>
  }
  const top = max ?? Math.max(...items.map((i) => i.value), 1)
  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <div key={item.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate" style={{ color: INK }}>{item.label}</span>
            <span className="shrink-0 tabular-nums" style={{ color: INK_3 }}>
              {item.hint ?? num(item.value)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full" style={{ background: '#f6f3fb' }}>
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(2, (item.value / top) * 100)}%`, background: SERIES[0] }}
              title={`${item.label}: ${item.hint ?? num(item.value)}`}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Полоса из двух долей. Между сегментами — зазор в цвет подложки, иначе на
 * стыке появляется ложная третья полоса.
 */
export function Split({
  left,
  right,
}: {
  left: { label: string; value: number; color: string }
  right: { label: string; value: number; color: string }
}) {
  const total = left.value + right.value
  const leftPct = total ? Math.round((left.value / total) * 100) : 0
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-3 overflow-hidden rounded-full" style={{ background: '#f6f3fb' }}>
        <div style={{ width: `${leftPct}%`, background: left.color }} />
        <div style={{ width: 2, background: '#fff' }} />
        <div style={{ width: `${100 - leftPct}%`, background: right.color }} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5" style={{ color: INK_2 }}>
          <span className="size-2.5 rounded-full" style={{ background: left.color }} aria-hidden />
          {left.label} — <strong className="tabular-nums" style={{ color: INK }}>{num(left.value)}</strong> ({leftPct}%)
        </span>
        <span className="flex items-center gap-1.5" style={{ color: INK_2 }}>
          <span className="size-2.5 rounded-full" style={{ background: right.color }} aria-hidden />
          {right.label} — <strong className="tabular-nums" style={{ color: INK }}>{num(right.value)}</strong> ({100 - leftPct}%)
        </span>
      </div>
    </div>
  )
}

/** Воронка: каждый шаг — доля от первого, подписи прямо на ступенях. */
export function Funnel({ steps }: { steps: { label: string; value: number }[] }) {
  const first = steps[0]?.value ?? 0
  if (!first) return <p className="text-sm" style={{ color: INK_3 }}>Нет данных</p>
  return (
    <div className="flex flex-col gap-2">
      {steps.map((step, index) => {
        const share = Math.round((step.value / first) * 100)
        const prev = index > 0 ? steps[index - 1].value : null
        const fromPrev = prev ? Math.round((step.value / prev) * 100) : null
        return (
          <div key={step.label}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
              <span style={{ color: INK }}>{step.label}</span>
              <span className="tabular-nums" style={{ color: INK_3 }}>
                {num(step.value)} · {share}%
                {fromPrev !== null && <span> (из прошлого шага {fromPrev}%)</span>}
              </span>
            </div>
            <div className="h-7 overflow-hidden rounded-lg" style={{ background: '#f6f3fb' }}>
              <div
                className="flex h-full items-center rounded-lg px-2"
                style={{ width: `${Math.max(4, share)}%`, background: SEQ[Math.min(SEQ.length - 1, 5 - index)] }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
