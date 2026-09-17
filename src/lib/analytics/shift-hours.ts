// Часы на смене и «вместе с кем» — по интервалам смен, уже обрезанным
// периодом (это делает SQL). Пересекающиеся смены одного человека не
// считаются дважды.

export interface ShiftInterval {
  staffId: string
  name: string
  from: number
  to: number
}

export interface StaffHours {
  staffId: string
  name: string
  totalMs: number
  /** Сколько из этого времени на смене был ещё кто-то. */
  togetherMs: number
  /** С кем и сколько — по каждому человеку отдельно. */
  withWhom: { staffId: string; name: string; ms: number }[]
}

type Span = [number, number]

function union(spans: Span[]): Span[] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out: Span[] = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

const length = (spans: Span[]) => spans.reduce((sum, [a, b]) => sum + (b - a), 0)

function intersect(x: Span[], y: Span[]): Span[] {
  const out: Span[] = []
  for (const [a1, b1] of x) {
    for (const [a2, b2] of y) {
      const a = Math.max(a1, a2)
      const b = Math.min(b1, b2)
      if (b > a) out.push([a, b])
    }
  }
  return union(out)
}

export function computeStaffHours(shifts: ShiftInterval[]): StaffHours[] {
  const byStaff = new Map<string, { name: string; spans: Span[] }>()
  for (const s of shifts) {
    const entry = byStaff.get(s.staffId) ?? { name: s.name, spans: [] }
    entry.spans.push([s.from, s.to])
    byStaff.set(s.staffId, entry)
  }
  const merged = [...byStaff.entries()].map(([staffId, v]) => ({ staffId, name: v.name, spans: union(v.spans) }))

  return merged.map((me) => {
    const others = merged.filter((o) => o.staffId !== me.staffId)
    const withWhom = others
      .map((o) => ({ staffId: o.staffId, name: o.name, ms: length(intersect(me.spans, o.spans)) }))
      .filter((w) => w.ms > 0)
      .sort((a, b) => b.ms - a.ms)
    const togetherMs = length(intersect(me.spans, union(others.flatMap((o) => o.spans))))
    return { staffId: me.staffId, name: me.name, totalMs: length(me.spans), togetherMs, withWhom }
  })
}
