import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react"

import { TimeChart, type ChartRow, type ChartSeries } from "@/components/Chart"
import { PingTooltip } from "@/components/ChartTooltip"
import { ProbeLegendButton } from "@/components/ProbeLegendButton"
import { ProbePicker } from "@/components/ProbePicker"

type Probe = { id: number; name: string; loss: number; points: { ts: number; latency: number | null }[] }
export type LatencyChartSelection = { view: "rows" | "compare"; ids: number[]; solo: number | null; hidden: number[] }
const COMPARE_LIMIT = 6
/** 线宽从图表标准 1.5px 起每档略粗一点，只做明度之外的辅助 */
const COMPARE_WIDTH_STEP = 0.15

/** 按当前线条数在两端灰阶间均匀分配：条数越少，相邻明度差越大 */
function compareStyle(index: number, count: number) {
  const span = Math.max(1, count - 1)
  const mix = Math.round((Math.min(index, span) / span) * 100)
  const color = mix === 0
    ? "var(--compare-strong)"
    : mix === 100
      ? "var(--compare-soft)"
      : `color-mix(in oklch, var(--compare-strong) ${100 - mix}%, var(--compare-soft))`
  return { stroke: color, width: 1.5 + Math.min(index, COMPARE_LIMIT - 1) * COMPARE_WIDTH_STEP }
}
const milliseconds = (value: number) => `${Number(value.toFixed(1))} ms`
const lossLabel = (value: number) => Number.isFinite(value) && value > 0 ? value < 1 ? "<1%" : `${Math.min(100, Math.round(value))}%` : "0%"

/** 名称和读数始终保留，只绘制滚动视口附近的曲线 */
function DeferredChart({ root, children }: { root: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const target = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = target.current
    if (!el) return
    if (typeof IntersectionObserver === "undefined") {
      // oxlint-disable-next-line react/set-state-in-effect
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root: root.current, rootMargin: "180px 0px" })
    observer.observe(el)
    return () => observer.disconnect()
  }, [root])
  return <div ref={target} className="h-28 w-full text-muted-foreground">{visible ? children : <div className="h-full rounded-sm bg-muted/20" />}</div>
}

export function LatencyCharts({ rows, probes, hours, step, smooth, connectGaps, smoothLines, from, to, onZoom, state, onStateChange }: {
  rows: ChartRow[]
  probes: Probe[]
  hours: number
  step?: number
  smooth: boolean
  connectGaps: boolean
  smoothLines: boolean
  from: number
  to: number
  onZoom: (from: number, to: number) => void
  state: LatencyChartSelection
  onStateChange: Dispatch<SetStateAction<LatencyChartSelection>>
}) {
  const { view, ids: selection, solo } = state
  const setView = (view: LatencyChartSelection["view"]) => onStateChange((previous) => ({ ...previous, view }))
  const setSolo = (solo: number | null) => onStateChange((previous) => ({ ...previous, solo }))
  const [hovered, setHovered] = useState<number | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  const [axisLeft, setAxisLeft] = useState(24)
  const scroller = useRef<HTMLDivElement>(null)
  const scrollTop = useRef(0)
  const [more, setMore] = useState(false)
  const selected = selection.filter((id) => probes.some((probe) => probe.id === id))
  const soloAvailable = solo !== null && probes.some((probe) => probe.id === solo)
  const legendIds = soloAvailable && !selected.includes(solo) ? [...selected, solo] : selected
  const compared = (solo === null ? selected : soloAvailable ? [solo] : []).filter((id) => !state.hidden.includes(id))
  const comparedProbes = compared.flatMap((id) => probes.find((probe) => probe.id === id) ?? [])
  const legendProbes = legendIds.flatMap((id) => probes.find((probe) => probe.id === id) ?? [])
  const rowByTs = useMemo(() => new Map(rows.map((row) => [row.ts, row])), [rows])
  const latest = useMemo(() => new Map(probes.map((probe) => [probe.id, probe.points.reduce<Probe["points"][number] | null>(
    (last, point) => Number.isFinite(point.ts) && point.ts > 0 && (!last || point.ts > last.ts) ? point : last, null,
  )])), [probes])
  const shareAxis = useCallback((left: number) => setAxisLeft((previous) => Math.max(previous, left)), [])
  const highlight = hovered ?? focused
  const activeHighlight = compared.includes(highlight ?? -1) ? highlight : null
  const style = (id: number) => {
    const at = selected.indexOf(id)
    return compareStyle(at >= 0 ? at : 0, at >= 0 ? selected.length : 1)
  }
  const singleStyle = () => ({ stroke: "var(--chart-1)" })
  const lineKey = (id: number) => `${smooth ? "su" : "tu"}${id}`
  const bandKey = (id: number) => `${smooth ? "cu" : "bu"}${id}`
  const toggle = (id: number) => onStateChange((previous) => {
    const active = previous.ids.filter((one) => probes.some((probe) => probe.id === one))
    if (previous.ids.includes(id)) return { ...previous, ids: previous.ids.filter((one) => one !== id), hidden: previous.hidden.filter((one) => one !== id), solo: null }
    if (active.length >= COMPARE_LIMIT) return previous
    return { ...previous, ids: [...active, id], hidden: previous.hidden.filter((one) => one !== id), solo: null }
  })
  const clearSelection = () => onStateChange({ ids: [], solo: null, view: "rows", hidden: [] })
  const selectAll = () => {
    if (probes.length === 0 || probes.length > COMPARE_LIMIT) return
    if (selected.length === probes.length) { clearSelection(); return }
    onStateChange((previous) => {
      const ids = probes.map((probe) => probe.id)
      const order = [...previous.ids.filter((id) => ids.includes(id)), ...ids.filter((id) => !previous.ids.includes(id))]
      return { ...previous, ids: order, hidden: [], solo: null }
    })
  }
  const lookAt = (id: number) => onStateChange((previous) => ({ ...previous, solo: id, view: "compare", hidden: previous.hidden.filter((one) => one !== id) }))
  const toggleShown = (id: number) => onStateChange((previous) => {
    const hidden = new Set(previous.hidden)
    // 未选中的线路可临时独看，隐藏后仍保留它自己的图例。
    const previewOnly = previous.solo === id && !previous.ids.includes(id)
    const shown = (previous.solo === null || previous.solo === id) && !hidden.has(id)
    if (previous.solo !== null && !previewOnly) {
      // 退出独看时，其余线路保持隐藏，由图例逐条恢复。
      for (const one of previous.ids) if (one !== previous.solo) hidden.add(one)
    }
    if (shown) hidden.add(id)
    else hidden.delete(id)
    return { ...previous, solo: previewOnly ? previous.solo : null, hidden: [...hidden] }
  })
  const lineOptions = { rows, hours, step, domain: "auto" as const, unit: "ms", connectGaps, smoothLines, from, to, onZoom }

  useLayoutEffect(() => {
    if (view === "rows" && scroller.current) scroller.current.scrollTop = scrollTop.current
  }, [view])
  useEffect(() => {
    const el = scroller.current
    if (!el || view !== "rows") return
    const update = () => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4)
    const observer = new ResizeObserver(update)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    el.addEventListener("scroll", update, { passive: true })
    update()
    return () => { observer.disconnect(); el.removeEventListener("scroll", update) }
  }, [view, probes.length])

  return (
    <div data-latency-charts data-latency-view={view} className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" aria-pressed={view === "rows"} onClick={() => { setView("rows"); setSolo(null) }} className={`tap tap-y-6 rounded-md px-2.5 py-1 text-xs ${view === "rows" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>分行</button>
        <button type="button" aria-pressed={view === "compare"} disabled={legendProbes.length === 0} onClick={() => setView("compare")} className={`tap tap-y-6 rounded-md px-2.5 py-1 text-xs disabled:opacity-40 ${view === "compare" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>对比{legendProbes.length > 0 ? ` · ${compared.length}` : ""}</button>
        {view === "rows" && probes.length > 0 && probes.length <= COMPARE_LIMIT && <button type="button" data-probe-select-all className="tap tap-y-6 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" onClick={selectAll}>{selected.length === probes.length ? "取消全选" : "全选"}</button>}
        <ProbePicker probes={probes} selected={selected} limit={COMPARE_LIMIT} onToggle={toggle} onClear={clearSelection} onAll={selectAll} />
        {selected.length > 0 && <button type="button" className="tap tap-y-6 text-xs text-muted-foreground hover:text-foreground" onClick={clearSelection}>清除选择</button>}
      </div>
      {view === "rows" ? (
        <div ref={scroller} data-latency-scroll data-more={more ? "" : undefined} tabIndex={0} role="group" aria-label="延迟线路" onScroll={(e) => { scrollTop.current = e.currentTarget.scrollTop }} className="max-h-[min(36rem,70dvh)] overflow-y-auto pr-1 focus-visible:outline-2 focus-visible:outline-ring [scrollbar-gutter:stable]">
          <div className="space-y-3">
          {probes.map((probe) => {
            const last = latest.get(probe.id)
            const value = last?.latency
            const chosen = selected.includes(probe.id)
            return (
              <div key={probe.id} data-latency-row={probe.id} className={`rounded-lg border p-3 ${chosen ? "border-ring bg-muted/20" : ""}`}>
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <label className="tap tap-y-15 shrink-0 cursor-pointer">
                    <input type="checkbox" data-probe-select={probe.id} aria-label={`对比：${probe.name}`} checked={chosen} disabled={!chosen && selected.length >= COMPARE_LIMIT} title={!chosen && selected.length >= COMPARE_LIMIT ? "最多对比六条线路" : probe.name} onChange={() => toggle(probe.id)} className="accent-foreground" />
                  </label>
                    <ProbeLegendButton row id={probe.id} name={probe.name} stroke="var(--chart-1)" loss={probe.loss} shown highlighted={false} onToggle={() => toggle(probe.id)} onSolo={() => lookAt(probe.id)} onHighlight={() => undefined} />
                  </div>
                  <div className="tnum flex w-full shrink-0 items-center gap-3 pl-6 text-xs text-muted-foreground sm:w-auto sm:pl-0">
                    <span data-probe-latest title={last ? `最近样本：${new Date(last.ts * 1_000).toLocaleString("zh-CN")}` : undefined} className="font-medium text-foreground">{typeof value === "number" && Number.isFinite(value) ? milliseconds(value) : last ? "无响应" : "无数据"}</span>
                    <span data-probe-loss>丢包 {lossLabel(probe.loss)}</span>
                  </div>
                </div>
                <DeferredChart root={scroller}>
                  <TimeChart {...lineOptions} left={axisLeft} onAxisLeftChange={shareAxis} series={[
                    { key: bandKey(probe.id), name: probe.name, color: "var(--chart-1)", band: true },
                    { key: lineKey(probe.id), name: probe.name, color: "var(--chart-1)" },
                  ]} label={`${probe.name}延迟走势`} renderTooltip={(row) => <PingTooltip active label={row.ts} rowByTs={rowByTs} probes={[probe]} smooth={smooth} style={singleStyle} />} />
                </DeferredChart>
              </div>
            )
          })}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {comparedProbes.length > 0 ? (
            <div className="h-56 w-full text-muted-foreground">
              <TimeChart {...lineOptions} series={[
                ...(comparedProbes.length === 1 ? [{ key: bandKey(comparedProbes[0].id), name: comparedProbes[0].name, color: style(comparedProbes[0].id).stroke, band: true }] : []),
                ...[...comparedProbes].sort((a, b) => Number(a.id === activeHighlight) - Number(b.id === activeHighlight)).map((probe): ChartSeries => {
                  const line = style(probe.id)
                  return { key: lineKey(probe.id), name: probe.name, color: line.stroke, opacity: activeHighlight === null || probe.id === activeHighlight ? 1 : 0.18, width: line.width }
                }),
              ]} label="节点延迟对比" renderTooltip={(row) => <PingTooltip active label={row.ts} rowByTs={rowByTs} probes={activeHighlight === null ? comparedProbes : comparedProbes.filter((probe) => probe.id === activeHighlight)} smooth={smooth} style={style} />} />
            </div>
          ) : <p className="py-8 text-center text-sm text-muted-foreground">{legendProbes.length > 0 ? "当前线路均已隐藏" : "没有选中的线路"}</p>}
          <div data-probe-legend className="flex flex-wrap items-center justify-center gap-1.5">
            {legendProbes.map((probe) => <ProbeLegendButton key={probe.id} id={probe.id} name={probe.name} stroke={style(probe.id).stroke} width={style(probe.id).width} loss={probe.loss} shown={compared.includes(probe.id)} highlighted={probe.id === activeHighlight} onToggle={() => toggleShown(probe.id)} onSolo={() => lookAt(probe.id)} onHighlight={(kind, active) => { if (kind === "hover") setHovered(active ? probe.id : null); else setFocused(active ? probe.id : null) }} />)}
          </div>
        </div>
      )}
    </div>
  )
}
