import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Answer } from '../api/types'
import { useSize } from '../lib/useSize'
import {
  answerEvent, buildModel, byMode, cap, days, long, readWhy, short, span, timeAxis, usd,
  type Model, type Plan, type StepRow,
} from './timeline/model'
import '../styles/timeline.css'

// The order timeline: for "why is X's order late", each step of the chain on a calendar. The closed
// port first, then every shipment in chain order, then the customer's order against its promised date.
// Planned dates come from the graph (GET /api/{tenant}/timeline); every delay, buffer and fee from the rows.
export interface OrderTimelineProps {
  tenant: string
  eventId: string | null
  answer: Answer          // template 'why_late': rows/columns as in questions.WHY_COLS, plus its graph
  reduced: boolean
}

interface Tip { title: string; lines: { k: string; v: string; tone?: 'danger' | 'ok' }[]; route?: string[]; foot?: string }
interface TipAt { tip: Tip; x: number; y: number }

export default function OrderTimeline({ tenant, eventId, answer, reduced }: OrderTimelineProps) {
  const why = useMemo(() => readWhy(answer), [answer])
  const ev = answerEvent(answer, eventId)
  const url = why && ev
    ? `/api/${encodeURIComponent(tenant)}/timeline?${new URLSearchParams({
      event_id: ev, shipments: why.steps.map(s => s.shipment).join(','), order: why.order })}`
    : null

  const [got, setGot] = useState<{ url: string; plan?: Plan; error?: string } | null>(null)
  useEffect(() => {
    if (!url) return
    const ctl = new AbortController()
    fetch(url, { signal: ctl.signal })
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => null) as { detail?: unknown } | null
          throw new Error(body?.detail ? String(body.detail) : `the server answered ${r.status}`)
        }
        return r.json() as Promise<Plan>
      })
      .then(plan => setGot({ url, plan }))
      .catch(e => { if (!ctl.signal.aborted) setGot({ url, error: e instanceof Error ? e.message : String(e) }) })
    return () => ctl.abort()
  }, [url])

  const built = useMemo(() => {
    if (!why || !got || got.url !== url || !got.plan) return null
    try { return { model: buildModel(why, got.plan) } } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
  }, [why, got, url])

  useEffect(() => {
    if (built?.model?.mismatches.length) console.warn('[timeline] graph and answer disagree; drawing the answer\'s numbers:', built.model.mismatches)
  }, [built])

  const [replay, setReplay] = useState(0)
  const [tipAt, setTipAt] = useState<TipAt | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [scrollRef, size] = useSize<HTMLDivElement>()
  const onTip = useCallback((tip: Tip | null, clientX: number, clientY: number) => {
    const r = rootRef.current?.getBoundingClientRect()
    setTipAt(tip && r ? { tip, x: clientX - r.left, y: clientY - r.top } : null)
  }, [])
  useEffect(() => setTipAt(null), [url])
  // Keep the tooltip inside the stage: beside the pointer, flipped left / up when it would run off.
  const tipRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = tipRef.current, root = rootRef.current
    if (!tipAt || !el || !root) return
    const w = el.offsetWidth, h = el.offsetHeight, W = root.clientWidth, H = root.clientHeight
    const left = tipAt.x + 16 + w <= W - 8 ? tipAt.x + 16 : tipAt.x - 16 - w
    const top = tipAt.y + 16 + h <= H - 8 ? tipAt.y + 16 : tipAt.y - 12 - h
    el.style.left = `${clamp(left, 8, W - w - 8)}px`
    el.style.top = `${clamp(top, 8, H - h - 8)}px`
  }, [tipAt])

  if (!why) return <div className="stage-empty">{answer.rows.length ? 'This answer has no chain to put on a calendar.' : 'No late order to show.'}</div>
  if (!ev) return <div className="stage-empty">Pick a disruption to see the timeline.</div>
  const error = (got?.url === url && got.error) || built?.error
  if (error) return <div className="stage-empty">The timeline could not load: {error}</div>
  const model = built?.model
  if (!model) return <div className="stage-empty"><span className="spinner" /></div>

  return (
    <div className={`otl${reduced ? '' : ' otl-anim'}`} ref={rootRef} onMouseLeave={() => setTipAt(null)}>
      <div className="otl-scroll" ref={scrollRef}>
        {size.width > 0 && (
          <Chart key={`${url}#${replay}`} m={model} width={size.width} height={size.height} onTip={onTip} />
        )}
      </div>
      <div className="otl-foot">
        <span className="otl-key"><i className="k-plan" />Planned trip</span>
        <span className="otl-key"><i className="k-late" />Days late at that step</span>
        <span className="otl-key"><i className="k-ok" />Buffer that soaked up delay</span>
        <span className="otl-key"><i className="k-closed" />Closed, then backlog</span>
        <span className="otl-key"><i className="k-promise" />Promised date</span>
        <span className="spacer" />
        {model.mismatches.length > 0 && (
          <span className="otl-warn" title={model.mismatches.join('\n')}>
            Planned dates and the answer disagree in {model.mismatches.length === 1 ? 'one place' : `${model.mismatches.length} places`}; the answer’s numbers are shown
          </span>
        )}
        {!reduced && <button className="btn small ghost otl-replay" onClick={() => { setTipAt(null); setReplay(k => k + 1) }}>Replay</button>}
      </div>
      {tipAt && (
        <div className="otl-tip" role="tooltip" ref={tipRef} style={{ left: tipAt.x + 16, top: tipAt.y + 16 }}>
          <b>{tipAt.tip.title}</b>
          <dl>{tipAt.tip.lines.map((l, i) => <div key={i}><dt>{l.k}</dt><dd className={l.tone ?? ''}>{l.v}</dd></div>)}</dl>
          {tipAt.tip.route && <ol className="otl-route">{tipAt.tip.route.map((r, i) => <li key={i}>{r}</li>)}</ol>}
          {tipAt.tip.foot && <p>{tipAt.tip.foot}</p>}
        </div>
      )}
    </div>
  )
}

// ---- the calendar ---------------------------------------------------------------------------------
const AXIS_H = 34
const BAR = 12
const FONT = "'Inter Variable', Inter, 'Segoe UI', system-ui, sans-serif"
let measure: CanvasRenderingContext2D | null | undefined
function tw(text: string, px: number, weight = 500) {
  if (measure === undefined) measure = document.createElement('canvas').getContext('2d')
  if (!measure) return text.length * px * 0.56
  measure.font = `${weight} ${px}px ${FONT}`
  return measure.measureText(text).width
}
function fit(text: string, maxW: number, px: number, weight = 500) {
  if (tw(text, px, weight) <= maxW) return text
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (tw(text.slice(0, mid) + '…', px, weight) <= maxW) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo).trimEnd() + '…'
}
function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)) }
const at = (t: number) => ({ '--d': `${t.toFixed(2)}s` }) as CSSProperties
const NOTE_PX = 11.5, LATE_PX = 12.5

interface ChartProps { m: Model; width: number; height: number; onTip: (tip: Tip | null, x: number, y: number) => void }

const Chart = memo(function Chart({ m, width, height, onTip }: ChartProps) {
  const uid = useId().replace(/:/g, '')
  const { epoch, steps, order } = m
  const n = steps.length
  const rows = n + 2
  const orderRow = n + 1
  const W = Math.max(600, width)
  const L = 4, R = W - 10
  // The label column is as wide as its longest line, within reason; long names are cut with "…" (full on hover).
  const labelW = clamp(Math.ceil(Math.max(
    ...steps.map(s => Math.max(tw(cap(s.what), 13, 600), tw(`${byMode(s.mode)} from ${s.from}`, 11.5))),
    tw(`${m.port.name} closed`, 13, 600), tw(`${order.customer}'s order`, 13, 600),
  )) + 26, 200, Math.round(W * 0.36))
  const C0 = L + labelW + 18                       // the calendar starts here
  const rowH = clamp(Math.floor((height - AXIS_H - 6) / rows), 38, 58)
  const H = AXIS_H + rows * rowH + 6
  const [d0, d1] = m.domain
  const axis = useMemo(() => timeAxis(m), [m])
  const ppd = (R - C0) / axis.total
  const x = (d: number) => C0 + axis.vis(clamp(d, d0, d1)) * ppd
  const rowTop = (r: number) => AXIS_H + r * rowH
  const mid = (r: number) => rowTop(r) + rowH / 2
  const line1 = (r: number) => mid(r) - 2
  const line2 = (r: number) => mid(r) + 12.5
  const barY = (r: number) => mid(r) - (rowH >= 46 ? 5 : 4)       // centre of the bar; the note sits under it
  const noteY = (r: number) => barY(r) + BAR / 2 + 12

  // Motion: the closure first, then the delay reaches each step in turn, then the order.
  const gap = Math.min(0.62, 3.6 / n)
  const tStep = (i: number) => 1.05 + i * gap
  const tOrder = tStep(n)

  const hover = (tip: Tip) => ({
    tabIndex: 0,
    onMouseEnter: (ev: React.MouseEvent) => onTip(tip, ev.clientX, ev.clientY),
    onMouseMove: (ev: React.MouseEvent) => onTip(tip, ev.clientX, ev.clientY),
    onMouseLeave: () => onTip(null, 0, 0),
    onFocus: (ev: React.FocusEvent<SVGGElement>) => {
      const b = ev.currentTarget.getBoundingClientRect()
      onTip(tip, b.left + b.width / 2, b.top + b.height / 2)
    },
    onBlur: () => onTip(null, 0, 0),
  })

  /** Where a note goes: wanted at `want` (its left end), slid left to stay inside the calendar. */
  const slide = (text: string, want: number, px = NOTE_PX, weight = 500) => {
    const w = tw(text, px, weight)
    return { x: clamp(want, C0, R - w), w }
  }
  /** "+N days late here": right of the bar; else under its red end (if the note leaves room); else left of the row. */
  const sideLabel = (text: string, right: number, left: number, note: { x: number; w: number } | null, px: number) => {
    const w = tw(text, px, 700)
    if (right + 8 + w <= R) return { x: right + 8, anchor: 'start' as const, below: false }
    const under = right - w
    if (under >= C0 && (!note || under > note.x + note.w + 14 || right < note.x - 14)) return { x: right, anchor: 'end' as const, below: true }
    if (left - 8 - w >= C0) return { x: left - 8, anchor: 'end' as const, below: false }
    return { x: clamp(right, C0 + w, R), anchor: 'end' as const, below: true }
  }

  // ---- axis ticks: every day / 2 days / Monday / other Monday / 1st of the month, whatever fits ----
  const ticks: number[] = []
  const months: number[] = []
  const every = [1, 2, 7, 14].find(s => s * ppd >= 46) ?? 30
  for (let d = Math.ceil(d0); d <= d1; d++) {
    if (axis.inBreak(d)) continue
    const dt = new Date(Date.parse(`${epoch}T00:00:00Z`) + d * 86_400_000)
    if (dt.getUTCDate() === 1) months.push(d)
    const monday = dt.getUTCDay() === 1
    if (every === 1 || (every === 2 && (d - d0) % 2 === 0) || (every === 7 && monday) ||
        (every === 14 && monday && Math.floor(d / 7) % 2 === 0) || (every === 30 && dt.getUTCDate() === 1)) ticks.push(d)
  }

  // ---- row 0: the closed port ----
  const ev = m.event
  const backlog = ev.backlog_days
  const portNote = `Closed ${span(epoch, m.closeFrom, m.closeTo)}${backlog ? `, then ${days(backlog)} to clear the backlog` : ''} · moving again ${short(epoch, m.clearDay)}`
  const portTip: Tip = {
    title: `${m.port.name}: ${ev.name}`,
    lines: [
      { k: 'Closed', v: `${long(epoch, m.closeFrom)} – ${long(epoch, m.closeTo)} (${days(m.closeTo - m.closeFrom + 1)})`, tone: 'danger' },
      ...(backlog ? [{ k: 'Backlog', v: `${long(epoch, m.closeTo + 1)} – ${long(epoch, m.clearDay - 1)} (${days(backlog)})` }] : []),
      { k: 'Moving again', v: long(epoch, m.clearDay) },
      ...m.otherPorts.map(h => ({ k: 'Also closed', v: h.name })),
    ],
  }

  const stepTip = (s: StepRow, prev: StepRow | null): Tip => ({
    title: cap(s.what),
    lines: [
      { k: 'Planned', v: `${long(epoch, s.depart)} → ${long(epoch, s.eta)}` },
      { k: 'Now', v: `${long(epoch, s.departNow)} → ${long(epoch, s.arriveNow)} · +${days(s.late)}`, tone: 'danger' },
      ...(s.touch ? [{ k: 'Stuck', v: `due ${s.touch.direction === 'arrives' ? 'into' : 'out of'} ${m.port.name} ${short(epoch, s.touch.day)} while it was shut; moving again ${short(epoch, m.clearDay)}`, tone: 'danger' as const }] : []),
      ...(prev ? [{ k: 'Waits for', v: `step ${prev.i + 1}, now arriving ${short(epoch, prev.arriveNow)}` }] : []),
      ...(prev ? [s.slack ? { k: 'Buffer', v: `${days(s.slack)}: soaked up ${s.absorbed} of the ${days(prev.late)}`, tone: 'ok' as const }
                          : { k: 'Buffer', v: `none: all ${days(prev.late)} pass on` }] : []),
    ],
    route: s.legs.slice(0, 7).map(l => `${span(epoch, l.depart_day, l.arrive_day)} · ${l.mode} · ${l.from.name} → ${l.to.name}`),
    foot: `${cap(byMode(s.mode))} from ${s.from} · shipment ${s.id}`,
  })

  // ---- the order ----
  const last = steps[n - 1]
  const promiseX = x(order.due)
  const promiseLabel = `Promised ${short(epoch, order.due)}`
  const pillW = tw(promiseLabel, 11.5, 650) + 18
  const pillX = clamp(promiseX - pillW / 2, C0, R - pillW)
  // Tick labels that do not collide with each other, a break label or the promised-date pill.
  const tickLabels = new Set<number>()
  const edges = axis.breaks.flatMap(b => [b.from, b.to])        // dates either side of a break anchor the scale
  let lastX = -Infinity
  for (const d of [...new Set([...ticks, ...edges])].sort((a, b) => a - b)) {
    const tx = x(d)
    if (tx < C0 + 14 || tx > R - 14 || tx - lastX < 44 || Math.abs(tx - (pillX + pillW / 2)) < pillW / 2 + 22) continue
    const label = tw(short(epoch, d), 11) / 2
    if (axis.breaks.some(b => Math.abs(tx - (x(b.from) + x(b.to)) / 2) < label + tw(`${b.to - b.from} days`, 10.5, 600) / 2 + 6)) continue
    tickLabels.add(d)
    lastX = tx
  }
  const orderTip: Tip = {
    title: `${order.customer}'s order to ${order.city}`,
    lines: [
      { k: 'Promised', v: long(epoch, order.due) },
      { k: 'Now arrives', v: long(epoch, order.arrive), tone: 'danger' },
      { k: 'Late', v: order.perDay != null
        ? `${days(order.daysLate)} × ${usd(order.perDay)} a day = ${usd(order.fee)} late fee`
        : `${days(order.daysLate)} · ${usd(order.fee)} late fee`, tone: 'danger' },
      ...(order.margin > 0 ? [{ k: 'Margin', v: `the parcel was planned for ${long(epoch, order.plannedArrive)}, ${days(order.margin)} early`, tone: 'ok' as const }] : []),
    ],
    foot: `Delivered by the ${last.what} (step ${n})`,
  }
  const orderNoteText = order.margin > 0
    ? `Planned to arrive ${short(epoch, order.plannedArrive)}: ${days(order.margin)} of margin absorbed`
    : `Promised ${long(epoch, order.due)} · now arrives ${long(epoch, order.arrive)}`
  const orderNote = slide(orderNoteText, Math.min(x(order.plannedArrive), promiseX) - 2)
  const orderLate = `${days(order.daysLate)} late · ${usd(order.fee)} late fee`
  const orderLbl = sideLabel(orderLate, x(order.arrive) + 6, Math.min(x(order.plannedArrive), promiseX) - 4, orderNote, 13)

  const summary = `${order.customer}'s order: promised ${long(epoch, order.due)}, now ${long(epoch, order.arrive)}. ` +
    `${m.port.name} closed ${span(epoch, m.closeFrom, m.closeTo)}; ` +
    steps.map(s => `step ${s.i + 1}, ${s.what}, ${days(s.late)} late`).join('; ') + '.'

  const label = (r: number, a: string, b: string, badge: ReactNode) => (
    <>
      {badge}
      <text className="otl-title" x={L + 24} y={line1(r)}>{fit(a, labelW - 24, 13, 600)}{a.length > 20 && <title>{a}</title>}</text>
      <text className="otl-sub" x={L + 24} y={line2(r)}>{fit(b, labelW - 24, 11.5)}<title>{b}</title></text>
    </>
  )
  const badgeY = (r: number) => (line1(r) + line2(r)) / 2 - 4.5

  return (
    <svg className="otl-svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
      <defs>
        <pattern id={`${uid}-hatch`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" className="otl-hatch-bg" />
          <line x1="0" y1="0" x2="0" y2="6" className="otl-hatch-line" />
        </pattern>
      </defs>

      {/* row bands, the label column's edge */}
      {Array.from({ length: rows }, (_, r) => (
        <rect key={r} className={`otl-band${r % 2 ? ' alt' : ''}${r === 0 ? ' port' : ''}${r === orderRow ? ' order' : ''}`}
          x={0} y={rowTop(r)} width={W} height={rowH} rx={r === 0 || r === orderRow ? 6 : 0} />
      ))}
      <line className="otl-edge" x1={C0 - 9} x2={C0 - 9} y1={AXIS_H - 4} y2={H - 6} />

      {/* calendar grid + axis */}
      <g>
        {months.map(d => <line key={`m${d}`} className="otl-grid month" x1={x(d)} x2={x(d)} y1={AXIS_H - 8} y2={H - 6} />)}
        {ticks.map(d => (
          <g key={d}>
            <line className="otl-grid" x1={x(d)} x2={x(d)} y1={AXIS_H - 8} y2={H - 6} />
            {tickLabels.has(d) && <text className="otl-tick" x={x(d)} y={AXIS_H - 13} textAnchor="middle">{short(epoch, d)}</text>}
          </g>
        ))}
        {edges.filter(d => tickLabels.has(d) && !ticks.includes(d)).map(d => (
          <text key={`e${d}`} className="otl-tick" x={x(d)} y={AXIS_H - 13} textAnchor="middle">{short(epoch, d)}</text>
        ))}
      </g>

      {/* squeezed stretches of time: nothing starts or ends there */}
      {axis.breaks.map(b => {
        const a = x(b.from), z = x(b.to), len = b.to - b.from
        const text = `${len} days`
        return (
          <g key={`b${b.from}`} className="otl-break">
            <title>{`${span(epoch, b.from, b.to - 1)}: ${days(len)} drawn short, nothing changes in between`}</title>
            <rect className="otl-break-band" x={a} y={AXIS_H - 8} width={z - a} height={H - AXIS_H + 2} />
            <path className="otl-break-edge" d={`M${a} ${AXIS_H - 8}V${H - 6}M${z} ${AXIS_H - 8}V${H - 6}`} />
            <text className="otl-break-label" x={(a + z) / 2} y={AXIS_H - 13} textAnchor="middle">
              {tw(text, 10.5, 600) + 6 < z - a + 40 ? text : '…'}
            </text>
          </g>
        )
      })}

      {/* the closure and its backlog, behind every row */}
      <g className="otl-grow" style={at(0.2)}>
        <rect className="otl-closed-bg" x={x(m.closeFrom)} y={AXIS_H - 8} width={x(m.closeTo + 1) - x(m.closeFrom)} height={H - AXIS_H + 2} />
        {backlog > 0 && <rect className="otl-backlog-bg" x={x(m.closeTo + 1)} y={AXIS_H - 8} width={x(m.clearDay) - x(m.closeTo + 1)} height={H - AXIS_H + 2} />}
      </g>

      {/* the promised date, down to the order */}
      <g className="otl-fade" style={at(0.35)}>
        <line className="otl-promise-line" x1={promiseX} x2={promiseX} y1={AXIS_H - 6} y2={barY(orderRow) - 8} />
        <g transform={`translate(${pillX} ${AXIS_H - 29})`}>
          <rect className="otl-pill" width={pillW} height={20} rx={10} />
          <text className="otl-pill-text" x={pillW / 2} y={14} textAnchor="middle">{promiseLabel}</text>
        </g>
      </g>

      {/* row 0: the closed port */}
      <g className="otl-row" {...hover(portTip)}>
        {label(0, `${m.port.name} closed`, m.otherPorts.length ? `with ${m.otherPorts.map(h => h.name).join(', ')} · ${ev.name}` : ev.name,
          <><circle className="otl-badge port" cx={L + 9} cy={badgeY(0)} r={9} />
            <text className="otl-badge-text dark" x={L + 9} y={badgeY(0) + 4} textAnchor="middle">!</text></>)}
        <g className="otl-grow" style={at(0.25)}>
          <rect className="otl-closed" x={x(m.closeFrom)} y={barY(0) - BAR / 2} width={x(m.closeTo + 1) - x(m.closeFrom)} height={BAR} rx={3} />
          {backlog > 0 && <rect className="otl-backlog" x={x(m.closeTo + 1)} y={barY(0) - BAR / 2} width={x(m.clearDay) - x(m.closeTo + 1)} height={BAR} rx={2}
            fill={`url(#${uid}-hatch)`} />}
        </g>
        <text className="otl-note danger otl-fade" style={at(0.6)} x={slide(portNote, x(m.closeFrom)).x} y={noteY(0)}>{portNote}</text>
      </g>

      {/* one row per shipment */}
      {steps.map((s, i) => {
        const r = i + 1
        const prev = i > 0 ? steps[i - 1] : null
        const t = tStep(i)
        const by = barY(r)
        const notch = prev && s.absorbed > 0 && s.bufferFrom != null
          ? { x1: x(s.bufferFrom), x2: x(s.bufferFrom + s.absorbed) } : null
        let note: { text: string; x: number; w: number; tone: string } | null = null
        if (s.touch) {
          const text = `Due ${s.touch.direction === 'arrives' ? 'into' : 'out of'} ${m.port.name} ${short(epoch, s.touch.day)}, while it was shut`
          note = { text, ...slide(text, x(s.touch.day) - 4), tone: 'danger' }
        } else if (notch) {
          const text = `${days(s.absorbed)} of buffer absorbed`
          note = { text, ...slide(text, notch.x1, NOTE_PX, 600), tone: 'ok' }
        } else if (prev) {
          const text = 'No buffer here'
          note = { text, ...slide(text, x(s.depart)), tone: '' }
        }
        const lateText = `+${days(s.late)} late here`
        const lbl = sideLabel(lateText, x(s.arriveNow), Math.min(x(s.depart), notch ? notch.x1 : Infinity), note, LATE_PX)
        return (
          <g key={s.id} className="otl-row" {...hover(stepTip(s, prev))}>
            {label(r, cap(s.what), `${byMode(s.mode)} from ${s.from}`,
              <><circle className="otl-badge" cx={L + 9} cy={badgeY(r)} r={9} />
                <text className="otl-badge-text" x={L + 9} y={badgeY(r) + 3.8} textAnchor="middle">{i + 1}</text></>)}

            {/* planned handoff (dotted) and the real one (red): it cannot leave before the step above arrives */}
            {prev && (
              <line className="otl-link-plan otl-fade" style={at(0.3)} x1={x(prev.eta)} x2={x(prev.eta)}
                y1={barY(r - 1) + BAR / 2 + 1} y2={by - BAR / 2 - 1} />
            )}
            {prev && (
              <path className="otl-link otl-draw" style={at(t)} pathLength={1}
                d={`M${x(prev.arriveNow)} ${barY(r - 1) + BAR / 2}V${(barY(r - 1) + by) / 2}H${x(s.departNow)}V${by - BAR / 2 - 1}`} />
            )}
            {s.touch && (
              <path className="otl-link otl-draw" style={at(t)} pathLength={1}
                d={`M${x(s.touch.day)} ${barY(0) + BAR / 2}V${by - BAR / 2 - 1}`} />
            )}

            {notch && (
              <rect className="otl-notch otl-pop" style={at(t + 0.12)} x={notch.x1} y={by - BAR / 2 + 1}
                width={Math.max(2, notch.x2 - notch.x1)} height={BAR - 2} rx={2} />
            )}
            <rect className={`otl-plan otl-fade${s.depart < d0 ? ' clipped' : ''}`} style={at(0.1)} x={x(s.depart)} y={by - BAR / 2}
              width={Math.max(3, x(s.eta) - x(s.depart))} height={BAR} rx={3} />
            {s.late > 0 && (
              <rect className="otl-late otl-grow" style={at(t + 0.3)} x={x(s.eta) - 1} y={by - BAR / 2}
                width={x(s.arriveNow) - x(s.eta) + 1} height={BAR} rx={3} />
            )}
            {axis.breaks.filter(b => s.depart < b.from && s.arriveNow > b.to).map(b => {
              const cx = (x(b.from) + x(b.to)) / 2
              return <path key={b.from} className="otl-cut otl-fade" style={at(0.1)}
                d={`M${cx - 5} ${by + 8}L${cx - 1} ${by - 8}M${cx + 1} ${by + 8}L${cx + 5} ${by - 8}`} />
            })}
            {s.touch && <circle className="otl-stuck otl-pop" style={at(t)} cx={x(s.touch.day)} cy={by} r={4.5} />}
            {prev && s.departNow > s.depart && <circle className="otl-leave otl-pop" style={at(t + 0.2)} cx={x(s.departNow)} cy={by} r={2.6} />}

            <text className="otl-late-label otl-fade" style={at(t + 0.6)} x={lbl.x} y={lbl.below ? noteY(r) : by + 4.5}
              textAnchor={lbl.anchor}>{lateText}</text>
            {note && <text className={`otl-note ${note.tone} otl-fade`} style={at(t + 0.2)} x={note.x} y={noteY(r)}>{note.text}</text>}
          </g>
        )
      })}

      {/* the customer's order */}
      <g className="otl-row" {...hover(orderTip)}>
        {label(orderRow, `${order.customer}'s order`, `to ${order.city} · promised ${short(epoch, order.due)}`,
          <rect className="otl-badge order" x={L + 3} y={badgeY(orderRow) - 6} width={12} height={12} rx={2}
            transform={`rotate(45 ${L + 9} ${badgeY(orderRow)})`} />)}
        <path className="otl-link otl-draw" style={at(tOrder)} pathLength={1}
          d={`M${x(last.arriveNow)} ${barY(n) + BAR / 2}V${(barY(n) + barY(orderRow)) / 2}H${x(order.arrive)}V${barY(orderRow) - 7}`} />
        {order.margin > 0 && (
          <rect className="otl-notch otl-pop" style={at(tOrder + 0.12)} x={x(order.plannedArrive)} y={barY(orderRow) - BAR / 2 + 1}
            width={Math.max(2, x(order.plannedArrive + order.margin) - x(order.plannedArrive))} height={BAR - 2} rx={2} />
        )}
        <rect className="otl-gap otl-grow" style={at(tOrder + 0.3)} x={promiseX} y={barY(orderRow) - BAR / 2}
          width={Math.max(2, x(order.arrive) - promiseX)} height={BAR} rx={3} />
        <Diamond cx={promiseX} cy={barY(orderRow)} className="otl-promise-mark" />
        <g className="otl-pop" style={at(tOrder + 0.7)}><Diamond cx={x(order.arrive)} cy={barY(orderRow)} className="otl-arrive-mark" /></g>
        <text className="otl-gap-label otl-fade" style={at(tOrder + 0.8)} x={orderLbl.x}
          y={orderLbl.below ? noteY(orderRow) : barY(orderRow) + 4.5} textAnchor={orderLbl.anchor}>{orderLate}</text>
        <text className={`otl-note ${order.margin > 0 ? 'ok' : ''} otl-fade`} style={at(tOrder + 0.4)} x={orderNote.x} y={noteY(orderRow)}>{orderNoteText}</text>
      </g>
    </svg>
  )
})

function Diamond({ cx, cy, className }: { cx: number; cy: number; className: string }) {
  return <rect className={className} x={cx - 5.5} y={cy - 5.5} width={11} height={11} rx={1.5} transform={`rotate(45 ${cx} ${cy})`} />
}
