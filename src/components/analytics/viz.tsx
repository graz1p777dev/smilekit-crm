'use client'

// Общие детали оформления аналитики.
//
// Палитра проверена валидатором dataviz (светлая поверхность): все пары
// различимы при дальтонизме и дают контраст выше 3:1. Фирменный #5115a4 для
// графиков слишком тёмный (выпадает из полосы светлоты), поэтому в марках
// используется его более светлый родственник #7c3aed, а сам бренд остаётся
// в заголовках, иконках и кнопках.
//
// OTHER — нейтральный серый для «прочих» (свёрнутый хвост категорий). Он
// нарочно без насыщенности, но проходит контраст 3:1 и различимость с SERIES
// (валидатор: ΔE ≥ 16 при дальтонизме); рядом всегда есть подпись и число.

import { Children, createContext, useContext, useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AlertCircle, ChevronRight, Clock, Info } from 'lucide-react'
import { getInitials } from '@/lib/formatters'

export const SERIES = ['#7c3aed', '#0d9488', '#ea580c'] as const
export const OTHER = '#8f879e'

/** Один тон, светлый → тёмный: для «больше/меньше», а не для «разное». */
export const SEQ = ['#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed'] as const

export const BRAND = '#5115a4'
export const BRAND_STRONG = '#360e7f'
export const BRAND_SOFT = '#f1ebfa'
export const INK = '#17102a'
export const INK_2 = '#4e4560'
export const INK_3 = '#766d88'
export const LINE = '#ece5f3'
/** Подложка под полосы: на шаг светлее серии, «пустая» часть шкалы. */
export const TRACK = '#f3effa'
export const BAD = '#b91c1c'

export const money = (value: number) => `${Math.round(value).toLocaleString('ru-RU')} сом`
export const num = (value: number) => value.toLocaleString('ru-RU')

/** Доля в процентах с одним знаком; при пустом знаменателе — «—». */
export const pct = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%` : '—'

export const phoneLabel = (chatId: string) => `+${chatId}`

/** Тикает раз в минуту, чтобы «сколько ждёт» не застывало. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}

// ─── Подсказка-правило ──────────────────────────────────────────────────────

/**
 * Кнопка «i»: правило подсчёта. Наведение — системная подсказка (title),
 * нажатие — текст раскрывается прямо под числом (работает и на телефоне).
 */
function useRule() {
  const [open, setOpen] = useState(false)
  return { open, toggle: () => setOpen((v) => !v) }
}

function RuleButton({ text, open, onClick, light }: { text: string; open: boolean; onClick: () => void; light?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={text}
      aria-expanded={open}
      aria-label="Как считается"
      className="-m-2 grid size-10 shrink-0 place-items-center rounded-full transition-colors md:m-0 md:size-6"
      style={{
        color: light ? 'rgba(255,255,255,0.85)' : INK_3,
        background: open ? (light ? 'rgba(255,255,255,0.18)' : BRAND_SOFT) : 'transparent',
      }}
    >
      <Info className="size-3.5" aria-hidden />
    </button>
  )
}

// ─── Каркас: карточка, заголовок блока ──────────────────────────────────────

export function Card({
  title,
  hint,
  icon: Icon,
  action,
  children,
  wide,
}: {
  title: string
  hint?: React.ReactNode
  icon?: LucideIcon
  action?: React.ReactNode
  children: React.ReactNode
  wide?: boolean
}) {
  return (
    <section
      className={`min-w-0 rounded-2xl bg-white p-4 md:p-5 ${wide ? 'md:col-span-2' : ''}`}
      style={{ border: `1px solid ${LINE}`, boxShadow: '0 1px 2px rgba(23,16,42,0.04)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          {Icon && (
            <span className="mt-px grid size-7 shrink-0 place-items-center rounded-lg" style={{ background: BRAND_SOFT, color: BRAND }}>
              <Icon className="size-4" aria-hidden />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold leading-snug" style={{ color: INK }}>{title}</h2>
            {hint && <p className="mt-0.5 text-[11px] leading-relaxed" style={{ color: INK_3 }}>{hint}</p>}
          </div>
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

/** Растягивать ли героя на всю ширину телефона: только при нечётном числе плиток, чтобы не было «сироты». */
const HeroWide = createContext(true)

/** Сетка KPI: две колонки на телефоне, четыре на широком экране. */
export function KpiGrid({ children }: { children: React.ReactNode }) {
  const odd = Children.count(children) % 2 === 1
  return (
    <HeroWide.Provider value={odd}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
    </HeroWide.Provider>
  )
}

type Tone = 'brand' | 'good' | 'warn'

const TONE: Record<Tone, { bg: string; fg: string }> = {
  brand: { bg: BRAND_SOFT, fg: BRAND },
  good: { bg: '#e3f4f1', fg: '#0f766e' },
  warn: { bg: '#fdf0e6', fg: '#c2410c' },
}

/**
 * KPI-плитка: иконка в мягкой подложке, крупное число, короткая подпись.
 * `sub` — короткое пояснение, видно всегда; `rule` — правило подсчёта, под «i».
 * `hero` — главная плитка вкладки, на фирменном градиенте (белый текст
 * допустим только на #5115a4 → #360e7f).
 */
export function Kpi({
  icon: Icon,
  label,
  value,
  sub,
  rule,
  tone = 'brand',
  hero,
}: {
  icon: LucideIcon
  label: string
  value: string
  sub?: React.ReactNode
  rule?: string
  tone?: Tone
  hero?: boolean
}) {
  const { open, toggle } = useRule()
  const heroWide = useContext(HeroWide)
  const t = TONE[tone]
  return (
    <div
      className={`flex min-w-0 flex-col rounded-2xl p-4 ${hero && heroWide ? 'col-span-2 lg:col-span-1' : ''}`}
      style={hero
        ? { background: `linear-gradient(135deg, ${BRAND} 0%, ${BRAND_STRONG} 100%)`, boxShadow: '0 8px 24px -12px rgba(81,21,164,0.55)' }
        : { background: '#fff', border: `1px solid ${LINE}`, boxShadow: '0 1px 2px rgba(23,16,42,0.04)' }}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="grid size-9 shrink-0 place-items-center rounded-xl"
          style={hero ? { background: 'rgba(255,255,255,0.14)', color: '#fff' } : { background: t.bg, color: t.fg }}
        >
          <Icon className="size-[18px]" aria-hidden />
        </span>
        {rule && <RuleButton text={rule} open={open} onClick={toggle} light={hero} />}
      </div>
      <div className="mt-3 break-words text-[22px] font-bold leading-tight tracking-tight sm:text-[26px] sm:leading-none" style={{ color: hero ? '#fff' : INK }}>
        {value}
      </div>
      <div className="mt-1.5 text-[13px] font-medium leading-snug" style={{ color: hero ? 'rgba(255,255,255,0.92)' : INK_2 }}>
        {label}
      </div>
      {sub && (
        <div className="mt-1 text-[11px] leading-snug" style={{ color: hero ? 'rgba(255,255,255,0.8)' : INK_3 }}>{sub}</div>
      )}
      {rule && open && (
        <p
          className="mt-2 rounded-lg px-2.5 py-2 text-[11px] leading-relaxed"
          style={hero ? { background: 'rgba(255,255,255,0.12)', color: '#fff' } : { background: '#f8f6fc', color: INK_2 }}
        >
          {rule}
        </p>
      )}
    </div>
  )
}

/** Маленький показатель внутри карточки (без своей рамки-плитки). */
export function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-xl px-3 py-2.5" style={{ background: '#f8f6fc' }}>
      <div className="text-lg font-bold leading-tight" style={{ color: INK }}>{value}</div>
      <div className="mt-0.5 text-xs" style={{ color: INK_2 }}>{label}</div>
      {sub && <div className="mt-0.5 text-[11px]" style={{ color: INK_3 }}>{sub}</div>}
    </div>
  )
}

/** Сноска-правило под блоком: мелко, но видно. */
export function Note({ children, tone }: { children: React.ReactNode; tone?: 'bad' }) {
  return (
    <p className="mt-3 text-[11px] leading-relaxed" style={{ color: tone === 'bad' ? BAD : INK_3 }}>{children}</p>
  )
}

// ─── Графики ────────────────────────────────────────────────────────────────

/**
 * Горизонтальные полосы. Одна серия — значит один тон: длина полосы уже
 * кодирует величину, разные цвета здесь были бы ложным вторым смыслом.
 * Нулевые строки приглушены, но не скрыты: «ноль» — тоже факт.
 */
export function Bars({
  items,
  max,
  color = SERIES[0],
}: {
  items: { label: string; value: number; hint?: string }[]
  max?: number
  color?: string
}) {
  if (items.length === 0) return <EmptyState text="Нет данных за период" />
  const top = max ?? Math.max(...items.map((i) => i.value), 1)
  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => {
        const shown = item.hint ?? num(item.value)
        const zero = item.value === 0
        return (
          <div key={item.label} title={`${item.label}: ${shown}`}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate" style={{ color: zero ? INK_3 : INK }}>{item.label}</span>
              <span className="shrink-0 font-semibold tabular-nums" style={{ color: zero ? INK_3 : INK }}>{shown}</span>
            </div>
            <div className="h-2 rounded-full" style={{ background: TRACK }}>
              {!zero && (
                <div className="h-full rounded-full" style={{ width: `${Math.max(1.5, (item.value / top) * 100)}%`, background: color }} />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export interface Segment {
  label: string
  value: number
  color: string
  /** Необязательное пояснение под подписью в легенде. */
  note?: string
}

/**
 * Сегментированная полоса «часть целого» + легенда с числами. Между
 * сегментами — 2px зазор цвета подложки. Доли — от `total` (по умолчанию
 * сумма сегментов).
 */
export function SegmentBar({ segments, total, columns = 3 }: { segments: Segment[]; total?: number; columns?: 2 | 3 | 4 }) {
  const sum = segments.reduce((s, x) => s + x.value, 0)
  const whole = total ?? sum
  const cols = columns === 4 ? 'grid-cols-2 sm:grid-cols-4' : columns === 2 ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'
  return (
    <div>
      <div className="flex h-3.5 gap-[2px] overflow-hidden rounded-full" style={{ background: TRACK }} role="img"
        aria-label={segments.map((s) => `${s.label}: ${num(s.value)}`).join(', ')}>
        {sum > 0 && segments.filter((s) => s.value > 0).map((s) => (
          <div
            key={s.label}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ flexGrow: s.value, flexBasis: 0, minWidth: 4, background: s.color }}
            title={`${s.label}: ${num(s.value)} · ${pct(s.value, whole)}`}
          />
        ))}
      </div>
      <div className={`mt-3 grid gap-x-4 gap-y-2.5 ${cols}`}>
        {segments.map((s) => (
          <div key={s.label} className="flex min-w-0 items-start gap-2">
            <span className="mt-1 size-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
            <div className="min-w-0">
              <div className="text-xs leading-snug" style={{ color: INK_2 }}>{s.label}</div>
              <div className="text-sm leading-snug" style={{ color: INK }}>
                <strong className="font-bold">{num(s.value)}</strong>
                <span className="ml-1.5 text-xs" style={{ color: INK_3 }}>{pct(s.value, whole)}</span>
              </div>
              {s.note && <div className="text-[11px] leading-snug" style={{ color: INK_3 }}>{s.note}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Полоса из двух долей: «получилось» против «остальных». Остаток — светлым
 * шагом той же шкалы, чтобы доля читалась по всей длине.
 */
export function Split({
  left,
  right,
}: {
  left: { label: string; value: number; color: string }
  right: { label: string; value: number; color: string }
}) {
  const total = left.value + right.value
  return (
    <div>
      <div className="flex h-3 gap-[2px] overflow-hidden rounded-full" style={{ background: TRACK }}>
        {left.value > 0 && (
          <div className="h-full rounded-l-full" style={{ flexGrow: left.value, flexBasis: 0, minWidth: 4, background: left.color }}
            title={`${left.label}: ${num(left.value)} · ${pct(left.value, total)}`} />
        )}
        {right.value > 0 && (
          <div className="h-full rounded-r-full" style={{ flexGrow: right.value, flexBasis: 0, minWidth: 4, background: right.color }}
            title={`${right.label}: ${num(right.value)} · ${pct(right.value, total)}`} />
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5" style={{ color: INK_2 }}>
          <span className="size-2.5 rounded-full" style={{ background: left.color }} aria-hidden />
          {left.label} — <strong style={{ color: INK }}>{num(left.value)}</strong> ({pct(left.value, total)})
        </span>
        <span className="flex items-center gap-1.5" style={{ color: INK_2 }}>
          <span className="size-2.5 rounded-full" style={{ background: right.color }} aria-hidden />
          {right.label} — <strong style={{ color: INK }}>{num(right.value)}</strong>
        </span>
      </div>
    </div>
  )
}

/** Кольцо-доля: одна величина от целого, число в центре. */
export function Ring({ part, whole, color = SERIES[1], track = '#d5efeb', label }: {
  part: number
  whole: number
  color?: string
  track?: string
  label: string
}) {
  const r = 42
  const c = 2 * Math.PI * r
  const share = whole ? Math.min(1, part / whole) : 0
  return (
    <div className="relative size-[112px] shrink-0" role="img" aria-label={`${label}: ${pct(part, whole)}`} title={`${label}: ${num(part)} из ${num(whole)}`}>
      <svg viewBox="0 0 100 100" className="size-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke={track} strokeWidth="9" />
        {share > 0 && (
          <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
            strokeDasharray={`${Math.max(0.5, share * c - 0.01)} ${c}`} />
        )}
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <span className="text-xl font-bold" style={{ color: INK }}>{pct(part, whole)}</span>
      </div>
    </div>
  )
}

// ─── Списки людей ───────────────────────────────────────────────────────────

/** Кружок с инициалами клиента. */
export function Avatar({ name }: { name: string | null }) {
  const initials = name?.trim() ? getInitials(name) : '?'
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-full text-xs font-bold" style={{ background: BRAND_SOFT, color: BRAND }} aria-hidden>
      {initials || '?'}
    </span>
  )
}

/**
 * Плашка «ждёт N» — срочность цветом, иконкой и текстом (не только цветом):
 * до 15 мин — спокойно, до часа — внимание, дольше — срочно.
 */
export function WaitPill({ ms, text, title }: { ms: number; text: string; title?: string }) {
  const min = ms / 60_000
  const style = min < 15
    ? { background: BRAND_SOFT, color: BRAND }
    : min < 60
      ? { background: '#fdf3dc', color: '#8a5300' }
      : { background: '#fde8dc', color: '#9a3412' }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-semibold" style={style} title={title}>
      <Clock className="size-3" aria-hidden />
      ждёт {text}
    </span>
  )
}

/** Строка списка клиента: аватар, имя (ссылка на сделку), телефон, справа — плашка. */
export function PersonRow({
  name,
  dealId,
  chatId,
  detail,
  right,
}: {
  name: string | null
  dealId: string | null
  chatId: string
  detail?: React.ReactNode
  right?: React.ReactNode
}) {
  return (
    <li className="flex items-start gap-3 py-2.5" style={{ borderTop: `1px solid ${LINE}` }}>
      <Avatar name={name} />
      {/* Плашка справа — только рядом с именем: подробности ниже идут на всю
          ширину, иначе на телефоне они сжимаются в узкую колонку. */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
            <ClientCell name={name} dealId={dealId} />
            <span className="text-xs tabular-nums" style={{ color: INK_3 }}>{phoneLabel(chatId)}</span>
          </div>
          {right}
        </div>
        {detail && <div className="mt-0.5 text-xs" style={{ color: INK_2 }}>{detail}</div>}
      </div>
    </li>
  )
}

/** Показывает первые `initial` строк, остальные — по кнопке. */
export function ShowMore<T>({ items, initial = 8, render }: { items: T[]; initial?: number; render: (item: T) => React.ReactNode }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, initial)
  return (
    <>
      <ul className="-mt-2.5">{shown.map(render)}</ul>
      {items.length > initial && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="mt-2 min-h-10 w-full rounded-xl py-2 text-xs font-semibold transition-colors hover:bg-[#ebe2f7]"
          style={{ background: BRAND_SOFT, color: BRAND }}
        >
          {all ? 'Свернуть' : `Показать все ${num(items.length)}`}
        </button>
      )}
    </>
  )
}

/** Раскрываемый список: заголовок-строка, содержимое по клику. */
export function Expand({ summary, children }: { summary: React.ReactNode; children: React.ReactNode }) {
  return (
    <details className="group rounded-xl" style={{ border: `1px solid ${LINE}` }}>
      <summary
        className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-xs transition-colors hover:bg-[#faf8fd] [&::-webkit-details-marker]:hidden"
        style={{ color: INK_2 }}
      >
        {summary}
        <ChevronRight className="size-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden style={{ color: INK_3 }} />
      </summary>
      <div className="px-3 pb-3">{children}</div>
    </details>
  )
}

/**
 * Таблица, которая на узком экране прокручивается сама, а не страница.
 * Первая колонка (кто/что) при прокрутке остаётся на месте.
 */
export function ScrollTable({ head, children, minWidth = 520 }: { head: string[]; children: React.ReactNode; minWidth?: number }) {
  return (
    <div className="-mx-1 overflow-x-auto overscroll-x-contain px-1">
      <table className="w-full text-xs [&_tr>*:first-child]:sticky [&_tr>*:first-child]:left-0 [&_tr>*:first-child]:z-[1] [&_tr>*:first-child]:bg-white" style={{ minWidth }}>
        <thead>
          <tr className="text-left" style={{ color: INK_3 }}>
            {head.map((h) => <th key={h} className="whitespace-nowrap py-2 pr-3 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody style={{ color: INK }}>{children}</tbody>
      </table>
    </div>
  )
}

/** Имя клиента со ссылкой на сделку, если она есть. */
export function ClientCell({ name, dealId }: { name: string | null; dealId: string | null }) {
  const label = name?.trim() || 'Без имени'
  if (!dealId) return <span className="font-medium" style={{ color: INK }}>{label}</span>
  return (
    <a href={`/dashboard/deals?deal=${dealId}`} className="-my-2.5 py-2.5 font-semibold underline-offset-2 hover:underline" style={{ color: BRAND }}>
      {label}
    </a>
  )
}

// ─── Состояния: пусто, загрузка, ошибка ─────────────────────────────────────

export function EmptyState({ icon: Icon = Info, text, sub }: { icon?: LucideIcon; text: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <span className="grid size-11 place-items-center rounded-2xl" style={{ background: BRAND_SOFT, color: BRAND }}>
        <Icon className="size-5" aria-hidden />
      </span>
      <p className="text-sm font-medium" style={{ color: INK_2 }}>{text}</p>
      {sub && <p className="max-w-xs text-xs" style={{ color: INK_3 }}>{sub}</p>}
    </div>
  )
}

export function ErrorState({ text }: { text: string }) {
  return (
    <div className="p-4 md:p-8">
      <div className="flex items-start gap-3 rounded-2xl px-4 py-3.5" style={{ background: '#fdecec', color: BAD }}>
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="text-sm">
          <p className="font-semibold">Не удалось посчитать</p>
          <p className="mt-0.5 text-xs">{text}</p>
        </div>
      </div>
    </div>
  )
}

const pulse = 'animate-pulse rounded-2xl bg-white'

/**
 * Скелет вкладки — по форме контента: ряд KPI, затем карточки с полосами
 * или строками списка.
 */
export function TabSkeleton({ text, tiles = 4, blocks = ['bars', 'bars'] }: {
  text: string
  tiles?: number
  blocks?: ('bars' | 'list' | 'chart')[]
}) {
  return (
    <div className="flex flex-col gap-4 p-4 md:p-8" aria-busy aria-label={text}>
      <p className="text-xs" style={{ color: INK_3 }}>{text}</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: tiles }, (_, i) => (
          <div key={i} className={`${pulse} h-[132px] p-4 ${i === 0 && tiles % 2 === 1 ? 'col-span-2 lg:col-span-1' : ''}`} style={{ border: `1px solid ${LINE}` }}>
            <div className="size-9 rounded-xl" style={{ background: TRACK }} />
            <div className="mt-3 h-6 w-20 rounded-md" style={{ background: TRACK }} />
            <div className="mt-2 h-3 w-28 rounded" style={{ background: TRACK }} />
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {blocks.map((kind, i) => (
          <div key={i} className={`${pulse} p-5`} style={{ border: `1px solid ${LINE}` }}>
            <div className="h-4 w-40 rounded" style={{ background: TRACK }} />
            <div className="mt-5 flex flex-col gap-4">
              {kind === 'chart' ? (
                <div className="flex h-36 items-end gap-2">
                  {[40, 65, 30, 80, 55, 70, 45].map((h, j) => (
                    <div key={j} className="flex-1 rounded-t" style={{ height: `${h}%`, background: TRACK }} />
                  ))}
                </div>
              ) : kind === 'list' ? (
                Array.from({ length: 4 }, (_, j) => (
                  <div key={j} className="flex items-center gap-3">
                    <div className="size-9 rounded-full" style={{ background: TRACK }} />
                    <div className="h-3 flex-1 rounded" style={{ background: TRACK }} />
                  </div>
                ))
              ) : (
                [90, 70, 45, 25].map((w, j) => (
                  <div key={j}>
                    <div className="mb-1.5 h-3 w-24 rounded" style={{ background: TRACK }} />
                    <div className="h-2 rounded-full" style={{ width: `${w}%`, background: TRACK }} />
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Внешняя обёртка вкладки: одинаковые поля и интервалы. */
export function TabBody({ children }: { children: React.ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-4 p-4 md:gap-5 md:p-8">{children}</div>
}

/** Вводная строка вкладки — правило, по которому отобраны данные. */
export function Lead({ children }: { children: React.ReactNode }) {
  return <p className="max-w-3xl text-xs leading-relaxed" style={{ color: INK_3 }}>{children}</p>
}
