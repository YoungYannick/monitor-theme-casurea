import { useEffect, useMemo, useState } from "react"

import { api, type Node } from "@/lib/api"
import { linePath } from "@/lib/chart-path"
import { clockFor } from "@/lib/format"
import { latestPing, withHistorySlot, withTimeGaps } from "@/lib/history"
import { latencyLineOptions } from "@/lib/site-settings"
import { useLatencyStyle } from "@/lib/theme-config"

/** `/api/nodes/{id}/metrics?series=ping` 返回里，本组件用到的几块（形状同详情页） */
type PingPoint = {
  task_id: number
  ts: number
  latency: number | null
  band?: [number, number]
  loss?: number
}
type Probes = Record<string, string>
type Loss = Record<string, number>

type Probe = { id: number; name: string; points: PingPoint[]; loss: number; step?: number }

function normalize(d: { ping?: PingPoint[]; probes?: Probes; loss?: Loss; step?: number }): Probe[] {
  const ping = d.ping ?? []
  const names = d.probes ?? {}
  const loss = d.loss ?? {}
  return [...new Set(ping.map((p) => p.task_id))]
    .map((id) => ({
      id,
      name: names[String(id)] ?? `探测 ${id}`,
      points: ping.filter((p) => p.task_id === id).sort((a, b) => a.ts - b.ts),
      loss: Number(loss[String(id)] ?? 0),
      step: d.step,
    }))
    .filter((p) => p.points.length > 0)
}

/**
 * 卡片的延迟数据多久算过期 页面上其余数字跟着 hub 的快照在跳，这一块要是只在挂载时
 * 取一次，访客开着页面看十几分钟仍是进页面那一刻的延迟 到点重新取一次，成本与首屏
 * 相同（仍走上面那个三条并发的队列）
 */
const TTL = 60_000

/**
 * 拉本节点最近一小时的延迟：点数取 40，够画一条能看出起伏的走势线，又不至于让每张
 * 卡片多背一大坨 刷新失败保留上次结果，并明确标记失败，避免把网络错误当作没有探测
 *
 * 每 `TTL` 刷新一次；页面切到后台时不发（省掉访客看不见的流量），回到前台时若手上这份
 * 已经过期就补一次 同一时刻只允许一条在飞，避免慢请求叠着打
 */
function useNodePing(id: number) {
  const [probes, setProbes] = useState<Probe[] | null>(null)
  const [failed, setFailed] = useState("")
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let alive = true
    let busy = false
    let fetchedAt = 0
    let controller: AbortController | null = null
    // oxlint-disable-next-line react/set-state-in-effect
    setProbes(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setFailed("")
    const load = () => {
      if (document.visibilityState !== "visible" || busy || Date.now() - fetchedAt < TTL) return
      busy = true
      fetchedAt = Date.now()
      const request = new AbortController()
      controller = request
      withHistorySlot(
        () => api<{ ping?: PingPoint[]; probes?: Probes; loss?: Loss; step?: number }>(
          `/nodes/${id}/metrics?hours=1&points=40&series=ping`,
          { signal: request.signal },
        ),
        request.signal,
      )
        .then((d) => {
          if (alive && !request.signal.aborted) { setProbes(normalize(d)); setFailed(""); setNow(Date.now()) }
        })
        .catch((e: Error) => {
          if (alive && !request.signal.aborted) setFailed(e.message || "网络错误")
        })
        .finally(() => {
          busy = false
          if (alive && request.signal.aborted && document.visibilityState === "visible") load()
        })
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") { setNow(Date.now()); load() }
      else { fetchedAt = 0; controller?.abort() }
    }
    load()
    const timer = window.setInterval(onVisible, TTL)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      alive = false
      controller?.abort()
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [id])
  return { probes, failed, now }
}

// 延迟分档：顺畅 / 偏高 / 糟，三档都走灰阶——这一块不抢旁边网络数的颜色，只用深浅说话
// 阈值取整百毫秒，跨海线路普遍在 150-200 之间，想改就改这两个数 丢包只要不为零，
// 至少抬到「偏高」；到 5% 直接算「糟」
const GOOD_MS = 100
const WARN_MS = 200
type Tone = "ok" | "warn" | "bad" | "none"

function toneOf(ms: number | null, loss: number): Tone {
  if (loss >= 5) return "bad"
  if (ms === null) return loss > 0 ? "warn" : "none"
  if (ms >= WARN_MS) return "bad"
  if (loss > 0 || ms >= GOOD_MS) return "warn"
  return "ok"
}

// 越糟越深：顺畅用弱化灰（和旁边的线路名同色，安静），偏高转深，糟用前景色顶格
// 数值与走势线共用这一个灰阶，一条线越黑越该看一眼
const toneClass = (tone: Tone) =>
  tone === "bad" ? "text-foreground"
    : tone === "warn" ? "text-foreground/70"
      : "text-muted-foreground"

const SPARK_W = 100
const SPARK_H = 20

/** 走势线与详情共用样式和路径算法；null 时间仍占轴宽，不压缩丢包或采样缺口 */
function Sparkline({ points, probeId, className, step }: { points: PingPoint[]; probeId: number; className: string; step?: number }) {
  const { style } = useLatencyStyle()
  const options = latencyLineOptions(style)
  const nums = points.filter((point) => Number.isFinite(point.ts) && typeof point.latency === "number" && Number.isFinite(point.latency))
    .map((point) => point.latency as number)
  if (nums.length < 2) return <span className="min-w-0 flex-1" />
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const times = points.filter((point) => Number.isFinite(point.ts)).map((point) => point.ts)
  const first = Math.min(...times)
  const last = Math.max(...times)
  const ratio = (value: number, low: number, high: number) => {
    if (high === low) return 0
    const span = high - low
    // 极端有限坐标相减也可能溢出，先减半后归一化；不向 SVG 传 NaN/Infinity
    const position = Number.isFinite(span) ? (value - low) / span : (value / 2 - low / 2) / (high / 2 - low / 2)
    return Math.max(0, Math.min(1, position))
  }
  const path = linePath(withTimeGaps(points, step).map((point) => point !== null && Number.isFinite(point.ts) && typeof point.latency === "number" && Number.isFinite(point.latency)
    ? { x: ratio(point.ts, first, last) * SPARK_W, y: max === min ? SPARK_H / 2 : SPARK_H - 2 - ratio(point.latency, min, max) * (SPARK_H - 4) }
    : null), options)
  return (
    <svg
      data-latency-sparkline={probeId}
      data-connect-gaps={options.connectGaps}
      data-smooth-lines={options.smooth}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className={`h-4 min-w-0 flex-1 ${className}`}
      aria-hidden="true"
    >
      <path
        data-series={`t${probeId}`}
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

type DisplayRow = { rule: string; probe?: Probe; hasRecords?: boolean }

/** 每个配置行保留一个位置 任务可选时按书写顺序取，超时也算有上报 */
function pickRows(probes: Probe[] | null, lines: string): DisplayRow[] {
  const all = probes ?? []
  const rules = [...new Set(lines.split("\n").map((line) => line.trim()).filter(Boolean))]
  if (rules.length === 0) return all.slice(0, 3).map((probe) => ({ rule: String(probe.id), probe }))
  const byName = new Map<string, Probe>()
  for (const p of all) if (!byName.has(p.name)) byName.set(p.name, p)
  type ChoiceRow = DisplayRow & { candidates: Probe[] }
  const rows: ChoiceRow[] = []
  const owners = new Map<Probe, ChoiceRow>()
  for (const rule of rules) {
    // 单独点名的任务优先占自己的行，也兼容原本就含竖线的任务名
    const exact = byName.get(rule)
    const names = exact ? [rule] : rule.split("|").map((name) => name.trim()).filter(Boolean)
    if (!names.length) continue
    const candidates = names.map((name) => byName.get(name)).filter((probe) => probe !== undefined)
    const row = { rule, candidates, hasRecords: candidates.length > 0, probe: exact }
    rows.push(row)
    if (exact) owners.set(exact, row)
  }

  function assign(row: ChoiceRow, visited: Set<ChoiceRow>): boolean {
    if (visited.has(row)) return false
    visited.add(row)
    // 候选重叠时先用空闲线路；若都被占用，尝试让已分配的行改用自己的备选
    const probe = row.candidates.find((p) => !owners.has(p))
      ?? row.candidates.find((p) => {
        const owner = owners.get(p)
        return owner !== undefined && assign(owner, visited)
      })
    if (!probe) return false
    owners.set(probe, row)
    row.probe = probe
    return true
  }
  for (const row of rows) if (!row.probe) assign(row, new Set())
  return rows
}

const sampleClock = clockFor(168)

/** 卡面与浮层使用同一读数：最新桶超时就显示超时，旧桶明确附上样本时间 */
function ProbeRow({ row, now, compact, emptyMessage, failed }: { row: DisplayRow; now: number; compact: boolean; emptyMessage: string; failed: string }) {
  const { probe } = row
  const { sample, stale } = latestPing(probe?.points ?? [], now)
  const ms = sample?.latency ?? null
  const gray = toneClass(toneOf(ms, probe?.loss ?? 0))
  const latencyText = !probe ? "—" : ms === null ? "超时" : `${ms} ms`
  const lossText = probe ? `${(probe.loss > 0 ? probe.loss : 0).toFixed(1)}%` : "—"
  const sampleInfo = sample ? `样本时间：${new Date(sample.ts * 1_000).toLocaleString("zh-CN")}`
    : row.hasRecords ? "可用线路已在其他行显示" : emptyMessage
  const status = failed ? `延迟刷新失败：${failed}` : sample && stale ? `数据陈旧 · ${sampleClock(sample.ts * 1_000)}` : ""
  return (
    <span className="block text-xs" title={[probe?.name, sampleInfo, status].filter(Boolean).join(" · ")}>
      <span className="flex h-4 items-center gap-2">
        <span className={`${compact ? "w-14" : "w-16"} shrink-0 truncate text-muted-foreground`}>{probe?.name ?? "—"}</span>
        <span className={`tnum ${compact ? "w-12" : "w-14"} shrink-0 text-right font-medium ${gray}`}>
          {latencyText}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1">
          {probe
            ? <Sparkline points={probe.points} probeId={probe.id} className={gray} step={probe.step} />
            : <span aria-hidden="true" className="flex-1 border-t border-dashed border-muted-foreground/50" />}
          {status && <span role={failed ? "status" : undefined} className={`min-w-0 truncate text-[10px] ${failed ? "text-destructive" : "text-muted-foreground"}`}>{status}</span>}
        </span>
        <span className={`tnum ${compact ? "w-9" : "w-10"} shrink-0 text-right text-muted-foreground`}>
          {lossText}
        </span>
      </span>
    </span>
  )
}

/**
 * 卡片底部那组「三网延迟」：一条线路一行——线路名、当前延迟、一小时走势、丢包率
 * 数据来自 hub 的 ping 历史（同详情页的延迟图），线路名用的是站长给 ping 任务起的名字
 * 显示哪几条由后台「三网延迟」指定（见 pickRows）；数据每 60 秒刷新一次（后台时停）
 */
export function LatencyPanel({ node, lines, compact = false }: { node: Node; lines: string; compact?: boolean }) {
  const { probes, failed, now } = useNodePing(node.id)
  const rows = useMemo(() => pickRows(probes, lines), [probes, lines])
  if (rows.length === 0 && !failed) return null
  const Panel = compact ? "span" : "div"
  const emptyMessage = probes !== null ? "暂无探测记录" : failed ? "未取得延迟数据" : "正在加载延迟数据"
  return (
    <Panel data-latency={compact ? undefined : ""} data-peek-latency={compact ? "" : undefined}
      className={compact ? "block space-y-1 border-t pt-2" : "mt-4 space-y-1.5 border-t pt-4"}>
      {rows.map((row, index) => <ProbeRow key={row.rule} row={row} now={now} compact={compact} emptyMessage={emptyMessage} failed={index === 0 ? failed : ""} />)}
      {!rows.length && failed && <span className="block text-xs text-destructive" role="status">延迟刷新失败：{failed}</span>}
    </Panel>
  )
}
