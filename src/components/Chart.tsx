import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"

import { ChartTooltip } from "@/components/ChartTooltip"
import { linePath } from "@/lib/chart-path"
import { clockFor, niceScale, quarters, timeTicks } from "@/lib/format"
import { nearestTimeIndex, timeIndexAtRatio, withTimeGaps } from "@/lib/history"

/**
 * 零依赖的时间序列图：坐标轴 + 网格 + 几条折线/面积 + 一枚悬停 tooltip
 *   · Y 轴从 0 起、刻度是 `quarters(top)`（top 由 `axisTop` 定）；`domain="auto"` 时按数据量程取整齐刻度；
 *   · X 轴是**真时间轴**（`timeTicks` 给的显式刻度）——agent 掉线那段时间不会被压成 0 宽；
 *   · 默认平滑并保留 null 断点；延迟图可选连接断点，仅改变路径；
 *   · 尺寸跟着父容器走（`ResizeObserver`）
 */
export type ChartSeries = {
  key: string
  name: string
  color: string
  /** 面积图：线下面填一层同色淡色；折线图不填 */
  area?: boolean
  /** 区间（band）：这一列的值是 `[低, 高]`，画成两条边之间的一块淡色（Smokeping 那种「烟」） */
  band?: boolean
  dash?: string
  opacity?: number
  width?: number
}

export type ChartRow = { ts: number } & Record<string, number | [number, number] | null | undefined>

const Y_LABEL_X = 2
const Y_AXIS_GAP = 8
const MIN_PLOT_LEFT = 24
const RIGHT = 8
const TOP = 6
const BOTTOM = 24
/** 刻度字号（与原来 `AXIS.fontSize` 一致） */
const FONT = 11
/** 11px 下大约的字符宽，用来判两个 X 刻度标签会不会撞上 */
const CHAR = 6.2

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** 取值域（band 那一列是 [低, 高]，两条边都要算进去） */
function extentOf(view: ChartRow[], keys: string[]): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  for (const row of view) {
    for (const key of keys) {
      const v = row[key]
      const pair = Array.isArray(v) ? v : [v]
      for (const one of pair) {
        const n = num(one)
        if (n === null) continue
        if (n < lo) lo = n
        if (n > hi) hi = n
      }
    }
  }
  return lo === Infinity ? null : [lo, hi]
}

/**
 * 自动刻度的整齐步长：把量程摊成 count 格，每格取「1 / 2 / 2.5 / 5 / 10 × 10^k」里第一个够大的，
 * 再把上下沿各向外扩到步长的整数倍 —— 就是原来 recharts `domain={["auto","auto"]}` 那套效果
 * （延迟轴不从 0 起：这些线路活在一条窄带里，锚到 0 会把起伏压平）
 */


export function TimeChart({
  rows,
  series,
  hours,
  step,
  top = 0,
  unit = "",
  format,
  yFormat,
  from = 0,
  to,
  label,
  domain = "zero",
  left,
  connectGaps = false,
  smoothLines = true,
  onAxisLeftChange,
  onZoom,
  renderTooltip,
}: {
  rows: ChartRow[]
  series: ChartSeries[]
  /** 窗口宽度，决定 X 轴标签的粒度（`clockFor`） */
  hours: number
  /** Hub 给出的桶宽，单位与 rows.ts 相同；缺字段时不推测缺桶 */
  step?: number
  /** `domain="zero"` 时的 Y 轴顶端；刻度是它的四等分 */
  top?: number
  /** 拼在 Y 轴刻度后面的单位（`%` / `/s` / `ms`），空字符串就不拼 */
  unit?: string
  /** 悬停 tooltip 里那个值怎么印（用自绘 tooltip 时可以不传） */
  format?: (value: number) => string
  /** Y 轴刻度怎么印，默认按原样（最多一位小数） */
  yFormat?: (value: number) => string
  /** 只看 `rows[from..to]` 这一段（缩放窗口用，索引是**全量数组**里的下标） */
  from?: number
  to?: number
  /** 给读屏用的一句话（这张图画的是什么） */
  label?: string
  /**
   * `zero`：Y 轴从 0 起、刻度是 `quarters(top)`（四张资源图）
   * `auto`：Y 轴按数据自身的量程取整齐刻度（延迟轴 —— 那些线路活在一条窄带里，
   *         锚到 0 会把抖动压平；这就是原来 `domain={["auto","auto"]}` 的意思）
   */
  domain?: "zero" | "auto"
  /** 显式指定 Y 轴留白；默认按刻度的实际文字宽度计算 */
  left?: number
  /** 只连接曲线中的有效样本；原始空值、悬停提示与区间填充仍保留 */
  connectGaps?: boolean
  /** 保留采样端点的平滑曲线，不改变数据或 Y 轴量程 */
  smoothLines?: boolean
  /** 分行图共享刻度留白，保持同一时间戳在各行的横向位置一致 */
  onAxisLeftChange?: (left: number) => void
  /** 给了它就能**在图上横向拖选一段缩放**（索引是全量数组里的下标） */
  onZoom?: (from: number, to: number) => void
  /** 自定义悬停内容（延迟图用它接 `PingTooltip`） */
  renderTooltip?: (row: ChartRow) => React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const axis = useRef<SVGGElement>(null)
  const clipId = useId()
  const tip = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [axisWidth, setAxisWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [pointerY, setPointerY] = useState<number | null>(null)
  const [tipSize, setTipSize] = useState({ w: 0, h: 0 })
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  // 按下即记录起点：拖动就扩选区，抬手时不足两个桶就不缩放
  const press = useRef<{ id: number; x: number; y: number; at: number; last: number; moved: boolean } | null>(null)

  // 横向拖动才拦页面滚动；纵向仍让页面滚。否则浏览器会把拖动判成 pan 并发出 pointercancel，选框中途丢失
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onTouchMove = (event: TouchEvent) => {
      const p = press.current
      const touch = event.touches[0]
      if (!p || !touch) return
      if (Math.abs(touch.clientX - p.x) > Math.abs(touch.clientY - p.y)) event.preventDefault()
    }
    el.addEventListener("touchmove", onTouchMove, { passive: false })
    return () => el.removeEventListener("touchmove", onTouchMove)
  }, [])

  // 卡片高度：用来把它夹在绘图区里（别顶出去）悬停的那一格变了才量一次
  useLayoutEffect(() => {
    const el = tip.current
    if (!el) return
    const read = () => setTipSize((previous) => {
      const next = { w: el.offsetWidth, h: el.offsetHeight }
      return previous.w === next.w && previous.h === next.h ? previous : next
    })
    const observer = new ResizeObserver(read)
    observer.observe(el)
    read()
    return () => observer.disconnect()
  }, [hover])

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    read()
    return () => ro.disconnect()
  }, [])

  const last = Math.max(0, rows.length - 1)
  const a = Math.min(Math.max(Math.round(from), 0), last)
  const b = Math.min(Math.max(to ?? last, a), last)
  const view = rows.slice(a, b + 1).filter((row) => Number.isFinite(row.ts) && row.ts > 0)
  const display = withTimeGaps(view, step)

  const w = size.w
  const h = size.h
  const plotLeft = left ?? Math.max(MIN_PLOT_LEFT, Y_LABEL_X + axisWidth + Y_AXIS_GAP)
  const plotW = Math.max(1, w - plotLeft - RIGHT)
  const plotH = Math.max(1, h - TOP - BOTTOM)
  const t0 = view.length ? view[0].ts : 0
  const t1 = view.length ? view[view.length - 1].ts : 1
  const span = Math.max(1, t1 - t0)

  // 刻度：零起点用 quarters(top)，自动档用数据量程取整齐步长
  const zeroTop = Number.isFinite(top) && top > 0 ? top : yFormat ? 1024 : 4
  const scale =
    domain === "auto"
      ? niceScale(...(extentOf(view, series.map((s) => s.key)) ?? [0, 1]))
      : { lo: 0, hi: zeroTop, ticks: quarters(zeroTop) }
  const yRange = Math.max(1e-9, scale.hi - scale.lo)

  const x = (ts: number) => plotLeft + ((ts - t0) / span) * plotW
  const y = (value: number) => TOP + plotH - ((value - scale.lo) / yRange) * plotH

  const tickStep = Math.abs((scale.ticks[1] ?? 1) - (scale.ticks[0] ?? 0))
  const tickDigits = tickStep > 0 ? Math.min(20, Math.max(0, 1 - Math.floor(Math.log10(tickStep)))) : 1
  const yLabel = yFormat ?? ((value: number) => String(Number(value.toFixed(tickDigits))))
  const tickLabels = scale.ticks.map((value) => `${yLabel(value)}${unit}`)
  const labelsKey = tickLabels.join("|")
  useLayoutEffect(() => {
    const el = axis.current
    if (!el) return
    let active = true
    const measure = () => {
      if (!active) return
      const width = Math.ceil(Math.max(0, ...[...el.querySelectorAll("text")].map((label) => label.getComputedTextLength())))
      setAxisWidth((previous) => previous === width ? previous : width)
    }
    measure()
    void document.fonts?.ready.then(measure)
    document.fonts?.addEventListener("loadingdone", measure)
    return () => {
      active = false
      document.fonts?.removeEventListener("loadingdone", measure)
    }
  }, [labelsKey, w, h])
  useLayoutEffect(() => {
    onAxisLeftChange?.(Math.max(MIN_PLOT_LEFT, Y_LABEL_X + axisWidth + Y_AXIS_GAP))
  }, [axisWidth, onAxisLeftChange])
  const xTicks = view.length > 1 ? timeTicks(t0, t1).filter((t) => t >= t0 && t <= t1) : []
  const clock = clockFor(hours)
  // 撞在一起的刻度标签直接丢掉（原来靠 recharts 的 minTickGap，这里自己算）：
  // 按 11px 的近似字宽排一遍，与前一个标签的右沿重叠就不画
  const keptX: number[] = []
  let edge = -Infinity
  for (const t of xTicks) {
    const half = (clock(t).length * CHAR) / 2
    const cx = x(t)
    if (cx - half < edge + 6) continue
    keptX.push(t)
    edge = cx + half
  }

  const lineOf = (s: ChartSeries) => linePath(
    display.map((row) => {
      if (row === null) return null
      const v = num(row[s.key])
      return v === null ? null : { x: x(row.ts), y: y(v) }
    }),
    { connectGaps, smooth: smoothLines },
  )

  /** 面积：每一段连续的点各自闭合成一块（同样不跨断点） */
  const areasOf = (s: ChartSeries) => {
    const out: string[] = []
    let run: { x: number; y: number }[] = []
    const flush = () => {
      if (run.length < 2) {
        run = []
        return
      }
      const base = TOP + plotH
      out.push(linePath(run, { smooth: smoothLines }) +
        `L${run[run.length - 1].x.toFixed(1)},${base.toFixed(1)}` +
        `L${run[0].x.toFixed(1)},${base.toFixed(1)}Z`)
      run = []
    }
    for (const row of display) {
      const v = row === null ? null : num(row[s.key])
      if (v === null) {
        flush()
        continue
      }
      if (row !== null) run.push({ x: x(row.ts), y: y(v) })
    }
    flush()
    return out
  }

  /** 断点之间仅剩一个有效样本时保留小实点，避免高丢包线路完全消失 */
  const isolatedOf = (s: ChartSeries) => {
    const out: { x: number; y: number }[] = []
    let run: { x: number; y: number }[] = []
    const flush = () => {
      if (run.length === 1) out.push(run[0])
      run = []
    }
    for (const row of display) {
      const value = row === null ? null : num(row[s.key])
      if (value === null) {
        if (!connectGaps) flush()
      } else if (row !== null) run.push({ x: x(row.ts), y: y(value) })
    }
    flush()
    return out
  }

  /** 区间（band）：上沿去、下沿回的一块；同样不跨断点 */
  const bandsOf = (s: ChartSeries) => {
    const out: string[] = []
    let run: { x: number; lo: number; hi: number }[] = []
    const flush = () => {
      if (run.length < 2) {
        run = []
        return
      }
      const up = run.map((p) => `${p.x.toFixed(1)},${y(p.hi).toFixed(1)}`).join("L")
      const down = [...run].reverse().map((p) => `${p.x.toFixed(1)},${y(p.lo).toFixed(1)}`).join("L")
      out.push(`M${up}L${down}Z`)
      run = []
    }
    for (const row of display) {
      const pair = row?.[s.key]
      const lo = num(Array.isArray(pair) ? pair[0] : null)
      const hi = num(Array.isArray(pair) ? pair[1] : null)
      if (lo === null || hi === null) {
        flush()
        continue
      }
      if (row !== null) run.push({ x: x(row.ts), lo, hi })
    }
    flush()
    return out
  }

  const indexAt = (clientX: number, el: Element) => {
    const rect = el.getBoundingClientRect()
    const ratio = (clientX - rect.left) / Math.max(1, rect.width)
    return timeIndexAtRatio(view, ratio)
  }

  // 悬停和正在拖选的两端也记时间；后台刷新替换数组时不会跳桶或越界
  const hovered = hover === null || view.length === 0 ? null : view[nearestTimeIndex(view, hover)]
  const payload = hovered
    ? series.map((s) => ({
        dataKey: s.key,
        name: s.name,
        color: s.color,
        value: num(Array.isArray(hovered[s.key]) ? null : hovered[s.key]),
        payload: hovered as unknown as Record<string, unknown>,
      }))
    : []
  const zoomed = !!onZoom && (a > 0 || b < last)
  const sel = drag && view.length > 0
    ? { lo: nearestTimeIndex(view, Math.min(drag.from, drag.to)), hi: nearestTimeIndex(view, Math.max(drag.from, drag.to)) }
    : null
  // 首次渲染还没量到 tip 尺寸：先藏起来，等量完再定位，避免 right 边界被算到容器外面
  const tipPlaced = tipSize.w > 0 && tipSize.h > 0

  return (
    <div ref={box} data-chart="" data-plot-left={plotLeft} data-connect-gaps={connectGaps} data-smooth-lines={smoothLines} className="relative h-full w-full select-none overflow-x-clip" onMouseLeave={() => { setHover(null); setPointerY(null) }}>
      {w > 0 && h > 0 && (
        <svg width={w} height={h} role="img" aria-label={label} className="overflow-visible">
          <defs>
            <clipPath id={clipId}>
              <rect x={plotLeft} y={TOP} width={plotW} height={plotH} />
            </clipPath>
          </defs>
          {/* 网格：只画横线（原来 `vertical={false}`），虚线、用边框色 */}
          {scale.ticks.map((v) => (
            <line
              key={`g${v}`}
              x1={plotLeft}
              x2={plotLeft + plotW}
              y1={y(v)}
              y2={y(v)}
              className="stroke-border"
              strokeDasharray="3 3"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ))}
          {/* Y 轴刻度 */}
          <g ref={axis} data-y-axis className="tnum">
          {scale.ticks.map((v, index) => (
            <text
              key={`y${v}`}
              x={Y_LABEL_X}
              y={y(v)}
              textAnchor="start"
              dominantBaseline="middle"
              fontSize={FONT}
              fill="currentColor"
            >
              {tickLabels[index]}
            </text>
          ))}
          </g>
          {/* X 轴刻度 */}
          {keptX.map((t) => (
            <text key={`x${t}`} x={x(t)} y={TOP + plotH + 14} textAnchor="middle" fontSize={FONT} fill="currentColor">
              {clock(t)}
            </text>
          ))}
          <g clipPath={`url(#${clipId})`}>
          {series.map((s) =>
            s.band
              ? bandsOf(s).map((d, i) => <path key={`b${s.key}${i}`} d={d} fill={s.color} fillOpacity={0.16} stroke="none" />)
              : null,
          )}
          {series.map((s) =>
            s.area ? (
              areasOf(s).map((d, i) => <path key={`a${s.key}${i}`} d={d} fill={s.color} fillOpacity={0.15} stroke="none" />)
            ) : null,
          )}
          {/* 线：band 那一列没有线（它的值是 [低, 高]，画成一块区间），别给它生成空路径 */}
          {series.filter((s) => !s.band).map((s) => (
            <g key={s.key} opacity={s.opacity ?? 1}>
            <path
              data-series={s.key}
              d={lineOf(s)}
              fill="none"
              stroke={s.color}
              strokeWidth={s.width ?? 1.5}
              strokeDasharray={s.dash}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {isolatedOf(s).map((point, index) => (
              <circle key={index} data-series-point={s.key} cx={point.x} cy={point.y} r={2} fill={s.color} />
            ))}
            </g>
          ))}
          </g>
          {/* 悬停竖线（原来 `CURSOR` 那枚） */}
          {hovered && !sel && (
            <line x1={x(hovered.ts)} x2={x(hovered.ts)} y1={TOP} y2={TOP + plotH} className="stroke-border" strokeWidth={1} />
          )}
          {/* 拖选中的那一段（松手才真的缩放）；轻点没有跨桶就不画选区 */}
          {sel && sel.hi > sel.lo && view.length > 1 && (
            <rect
              x={x(view[sel.lo].ts)}
              y={TOP}
              width={Math.max(1, x(view[sel.hi].ts) - x(view[sel.lo].ts))}
              height={plotH}
              fill="currentColor"
              opacity={0.08}
            />
          )}
          {/* 命中层：整块绘图区接指针，按 x 找最近的那个点；给了 onZoom 就能横向拖选缩放 */}
          <rect
            x={plotLeft}
            y={TOP}
            width={plotW}
            height={plotH}
            fill="transparent"
            // `pan-y`：手机上竖着划仍然滚页面，只有横向拖才被这里接走
            style={onZoom ? { touchAction: "pan-y" } : undefined}
            onMouseMove={(e) => {
              if (view.length === 0) return
              setHover(view[indexAt(e.clientX, e.currentTarget)].ts)
              // 卡片要跟着鼠标走，所以纵坐标也记下来（原来是钉在图表顶端的）
              const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect()
              setPointerY(Math.min(Math.max(e.clientY - rect.top, 0), rect.height))
            }}
            onPointerDown={(e) => {
              if (view.length === 0) return
              // 捕获失败不该让整段拖选失效（指针已经消失、或合成事件没有有效 id 时会抛）
              try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 无所谓 */ }
              const at = view[indexAt(e.clientX, e.currentTarget)].ts
              const canZoom = !!onZoom && view.length >= 3
              // 按下就算拖选起点（鼠标/触摸一致）；触摸同时先把该点数值亮出来
              press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, at, last: at, moved: canZoom }
              if (e.pointerType !== "mouse") setHover(at)
              if (canZoom) setDrag({ from: at, to: at })
            }}
            onPointerMove={(e) => {
              if (view.length === 0) return
              const at = view[indexAt(e.clientX, e.currentTarget)].ts
              const p = press.current
              if (e.pointerType !== "mouse" && !drag) setHover(at)
              if (!p || p.id !== e.pointerId || !p.moved) return
              p.last = at
              setDrag({ from: p.at, to: at })
            }}
            onPointerUp={() => {
              const p = press.current
              press.current = null
              if (!p) return
              // 没拖开就是"看数值"，保留浮层，不缩放
              if (!p.moved) {
                setDrag(null)
                return
              }
              const lo = nearestTimeIndex(view, Math.min(p.at, p.last))
              const hi = nearestTimeIndex(view, Math.max(p.at, p.last))
              setDrag(null)
              if (onZoom && hi - lo >= 2) onZoom(rows.indexOf(view[lo]), rows.indexOf(view[hi]))
            }}
            onPointerCancel={() => {
              press.current = null
              setDrag(null)
            }}
          />
        </svg>
      )}
      {/* 缩放着的时候给一枚重置（原来 recharts 的 Brush 是拖两端把手，这里改成图上拖选 + 这枚按钮） */}
      {zoomed && onZoom && (
        <button
          type="button"
          onClick={() => onZoom(0, last)}
          className="tap tap-y-6 absolute top-0 right-1 rounded-md border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          重置
        </button>
      )}
      {hovered && !drag && (
        <div
          ref={tip}
          className="pointer-events-none absolute z-30 w-max max-w-full"
          // 纵向**跟着鼠标**走（原来是钉在图表顶端）：以光标为中心，再夹在绘图区里 ——
          // 上下两头各留一点，别顶出图外，也别盖住 x 轴标签
          // 横向仍贴着光标那条竖线（靠右时翻到左边），与原来一致
          style={{
            top: tipPlaced ? Math.min(Math.max((pointerY ?? plotH / 2) - tipSize.h / 2 + TOP, TOP), Math.max(TOP, TOP + plotH - tipSize.h)) : TOP,
            left: tipPlaced ? Math.max(0, Math.min(x(hovered.ts) + 8 + tipSize.w > w ? x(hovered.ts) - tipSize.w - 8 : x(hovered.ts) + 8, w - tipSize.w)) : 0,
            visibility: tipPlaced ? undefined : "hidden",
          }}
        >
          {renderTooltip ? (
            renderTooltip(hovered)
          ) : (
            <ChartTooltip active label={hovered.ts} payload={payload} format={format ?? ((v: number) => String(v))} />
          )}
        </div>
      )}
    </div>
  )
}
