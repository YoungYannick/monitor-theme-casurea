import { useEffect, useMemo, useRef, useState } from "react"

import { Info } from "lucide-react"

import { TimeChart } from "@/components/Chart"
import { PingTooltip } from "@/components/ChartTooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { Country, deployed, RemarkChips } from "@/components/NodeCard"
import { api, type Node } from "@/lib/api"
import {
  axisBytes, axisTop, bytes, despike, cpuName, offlineSeconds, osName, rate, uptime,
} from "@/lib/format"
import { hasDetailRemarks, remarkChips } from "@/lib/notes"
import { latencyLineOptions, latencyStyleFromOptions, remarksOnCards, type RemarkPlacement } from "@/lib/site-settings"
import { useLatencyStyle } from "@/lib/theme-config"
import { rangesFor } from "@/lib/ranges"
import { timeRangeIndices, withHistorySlot } from "@/lib/history"
import { countAxisTop, resourceHistory, type MetricPoint } from "@/lib/resource-history"

type Point = MetricPoint
// `latency` 是桶内中位往返（全超时为 null）；`band` 是答案跨度；`loss` 是超时百分比
type PingPoint = {
  task_id: number
  ts: number
  latency: number | null
  band?: [number, number]
  loss?: number
}
type Probes = Record<string, string>
/** 整窗丢包率（hub 按次数算好下发，桶里的 `loss` 已是百分比、没法在这边再平均） */
type Loss = Record<string, number>

// 时间范围那排按钮由 hub 的保留天数生成（见 @/lib/ranges）
// 九个色相、再配一版短虚线：第十条起色相重复、换线型
const COLORS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `var(--chart-${n})`)
const PALETTE = [
  ...COLORS.map((stroke) => ({ stroke, dash: undefined })),
  ...COLORS.map((stroke) => ({ stroke, dash: "6 3" })),
]

const TABS = [
  { key: "resources", label: "资源" },
  { key: "latency", label: "网络延迟" },
] as const

const HISTORY_TTL = 60_000
/** 实时档的滚动窗口：预加载与常驻都只看最近这十分钟 */
const LIVE_WINDOW = 600
/** 实时缓冲的缺测容差：垫底的历史是分钟桶，快照约 2 秒一推；超过它才当断点 */
const LIVE_GAP_MS = 65_000

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h4>
      <div className="h-40 w-full text-muted-foreground">{children}</div>
    </div>
  )
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      onClick={onClick}
      className={`tap tap-y-6 rounded-md px-2.5 py-1 text-xs transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
      }`}
    >
      {children}
    </button>
  )
}

/** 削峰窗口按「时长」而非「点数」取：同一窗口在桌面是 1 分钟桶、手机是 2 分钟桶
 *  奇数（有中点）、夹在 3~15 之间 */
function despikeWindow(points: { ts: number }[]): number {
  let step = Infinity
  for (let i = 1; i < points.length; i++) step = Math.min(step, points[i].ts - points[i - 1].ts)
  return Math.min(15, Math.max(3, Math.round(420 / step) | 1))
}

/** 在线时长：没接入（从未上报）与离线是两回事，后者写清已离线多久 */
function onlineFor(node: Node) {
  if (node.online) return node.metrics ? uptime(node.metrics.uptime) : "—"
  if (!deployed(node)) return "未接入"
  const down = offlineSeconds(node)
  return down !== null && down >= 60 ? `离线 ${uptime(down)}` : "离线"
}

function Fact({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === "") return null
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm">{value}</dd>
    </div>
  )
}

export function NodeDetail({ node, embedded = false, onOpenDetail, historyDays, remarkPlacement }: {
  node: Node
  /** 紧凑形态点开一行时的就地渲染：省掉身份行与规格，直接落在延迟上，高度写死 */
  embedded?: boolean
  /** 就地展开时通往整页详情的口子 不传就不画那个链接 */
  onOpenDetail?: () => void
  /** hub 的历史保留天数（`/api/me` 的 `history_days`）；老 hub 不给，按 7 天算（见 @/lib/ranges） */
  historyDays?: number
  /** 「备注显示位置」：`embedded`（紧凑展开行）算「卡片」那一侧，整页详情那一块算「详情页」那一侧 */
  remarkPlacement?: RemarkPlacement
}) {
  // 备注（见 @/lib/notes）拆成小卡片：私有在前、公有在后；按「备注显示位置」
  // 分别取「卡片」侧（embedded 展开行）与「详情页」侧
  const chips = remarkChips(node)
  const cardChips = remarksOnCards(remarkPlacement ?? "both") ? chips : []
  // 判据与骨架共用一处（hasDetailRemarks），免得骨架对不上高度
  const detailChips = hasDetailRemarks(node, remarkPlacement ?? "both") ? chips : []
  const [peekOpen, setPeekOpen] = useState(false)
  const peekRef = useRef<HTMLSpanElement | null>(null)
  // 摊开时点别处 / Esc 收起
  useEffect(() => {
    if (!peekOpen) return
    const onDown = (e: PointerEvent) => {
      const el = e.target
      if (!(el instanceof globalThis.Node) || !peekRef.current?.contains(el)) setPeekOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPeekOpen(false) }
    document.addEventListener("pointerdown", onDown)
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey) }
  }, [peekOpen])
  // 就地展开只为看延迟，页签默认落在延迟而不是资源
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>(embedded ? "latency" : "resources")
  // 资源页签多一档「实时」（默认）：快照走前端自攒缓冲，历史档才走 /metrics 请求
  // 两个页签各记各的选中值
  const [resourceRange, setResourceRange] = useState<number | "live">("live")
  const [latencyRange, setLatencyRange] = useState(6)
  // 可选窗口按保留天数生成（见 @/lib/ranges）
  const RANGES = rangesFor(historyDays)
  const isLive = tab === "resources" && resourceRange === "live"
  // 历史请求的窗口小时数；实时档给个占位（1），只在首次 seed 时用到
  const hours = tab === "latency" ? latencyRange : resourceRange === "live" ? 1 : resourceRange
  // 资源页签实时的本机缓冲（MetricPoint 秒级时间戳）与各资源图的拖选缩放（记时间戳）
  const [liveRows, setLiveRows] = useState<Point[]>([])
  const [liveSeeded, setLiveSeeded] = useState(false)
  const [resourceZoom, setResourceZoom] = useState<Record<string, [number, number] | null>>({})
  const [smooth, setSmooth] = useState(false)
  const { style: latencyStyle, siteDefault, onChange: chooseLatencyStyle } = useLatencyStyle()
  const { connectGaps, smooth: smoothLines } = latencyLineOptions(latencyStyle)
  // 隐藏的探测：藏掉慢线，轴随剩余的线重定标，快线才读得清
  const [hiddenProbes, setHiddenProbes] = useState<number[]>([])
  const [data, setData] = useState<{ metrics: Point[]; ping: PingPoint[]; probes: Probes; loss?: Loss; step?: number } | null>(null)
  // 请求被拒（hub 限制并发历史窗口会答 503）与空窗口是两回事，分开记
  const [failed, setFailed] = useState("")
  const [updatedAt, setUpdatedAt] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const reload = useRef<() => void>(() => {})
  // 缩放记时间戳，不记数组下标：刷新后窗口左端滑走一桶，仍看同一段时间
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  // 图在页面上的起点（视口坐标 + scrollY），高度据此占满余下屏幕
  const [chartTop, setChartTop] = useState(0)

  useEffect(() => {
    // 实时档不发历史请求：资源数据走下面那个 live 采集，旧历史结果留着切回来时用
    if (isLive) return
    let active = true
    let busy = false
    let hadData = false
    let attemptedAt = 0
    let controller: AbortController | null = null
    // 新窗口在途时先清掉旧图
    // oxlint-disable-next-line react/set-state-in-effect
    setData(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setZoom(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setResourceZoom({})
    // oxlint-disable-next-line react/set-state-in-effect
    setFailed("")
    // oxlint-disable-next-line react/set-state-in-effect
    setUpdatedAt(0)
    // 屏幕能画多少设备像素就要多少点；页签决定要哪一半数据
    const points = Math.round(globalThis.innerWidth * (globalThis.devicePixelRatio || 1))
    const series = tab === "latency" ? "ping" : "metrics"
    const load = (force = false) => {
      if (!active || busy || document.visibilityState !== "visible" || (!force && Date.now() - attemptedAt < HISTORY_TTL)) return
      busy = true
      attemptedAt = Date.now()
      setRefreshing(true)
      const request = new AbortController()
      controller = request
      withHistorySlot(
        () => api<{ metrics: Point[]; ping: PingPoint[]; probes: Probes; loss?: Loss; step?: number }>(
          `/nodes/${node.id}/metrics?hours=${hours}&points=${points}&series=${series}`,
          { signal: request.signal },
        ),
        request.signal,
      )
        .then((next) => {
          if (!active || request.signal.aborted) return
          hadData = true
          setData(next)
          setUpdatedAt(Date.now())
          setFailed("")
        })
        .catch((e: Error) => {
          if (!active || request.signal.aborted) return
          setFailed(e.message || "网络错误")
          if (!hadData) setData({ metrics: [], ping: [], probes: {} })
        })
        .finally(() => {
          busy = false
          if (active) {
            setRefreshing(false)
            // 快速切回前台时，旧的取消请求可能尚未结束，结束后补取一次
            if (request.signal.aborted && document.visibilityState === "visible") load()
          }
        })
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") load()
      else { attemptedAt = 0; controller?.abort() }
    }
    reload.current = () => load(true)
    load()
    const timer = window.setInterval(onVisible, HISTORY_TTL)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      active = false
      controller?.abort()
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
      reload.current = () => {}
    }
  }, [node.id, hours, tab, isLive])

  // 实时档的垫底：历史明细是分钟桶、窗口下限 1 小时，故取 1 小时 / 60 桶，
  // 截最近十分钟（多留一分钟容差）与快照攒的点合并——切回来时图不空白
  useEffect(() => {
    if (!isLive) return
    // 切进实时档先清掉历史档留下的旧时间戳：接下来由快照采集刷新（离线节点收不到快照，
    // 状态行不该一直停在上一回历史请求的时刻）
    // oxlint-disable-next-line react/set-state-in-effect
    setUpdatedAt(0)
    let active = true
    const controller = new AbortController()
    withHistorySlot(
      () => api<{ metrics: Point[] }>(
        `/nodes/${node.id}/metrics?hours=1&points=60&series=metrics`,
        { signal: controller.signal },
      ),
      controller.signal,
    )
      .then((next) => {
        if (!active) return
        const floor = Date.now() / 1_000 - LIVE_WINDOW - 60
        // 同一时间戳以快照攒的点为准（seed 在前、rows 在后，Map 留后者）
        setLiveRows((rows) => {
          const merged = new Map<number, Point>()
          for (const p of [...next.metrics.filter((p) => p.ts >= floor), ...rows]) merged.set(p.ts, p)
          return [...merged.values()].sort((a, b) => a.ts - b.ts)
        })
        setLiveSeeded(true)
      })
      .catch(() => { if (active) setLiveSeeded(true) })
    return () => { active = false; controller.abort() }
  }, [isLive, node.id])

  // 实时档的追加：WebSocket 每 2 秒推一次快照、`node.metrics` 随之换引用，
  // 这里把新值记成一个点（同一秒只记一次），窗口滚动、裁掉十分钟之前的旧点
  useEffect(() => {
    if (!isLive || !node.metrics) return
    const m = node.metrics
    // oxlint-disable-next-line react/set-state-in-effect
    setLiveRows((rows) => {
      const ts = Math.floor(Date.now() / 1_000)
      if (rows.length > 0 && rows[rows.length - 1].ts >= ts) return rows
      const point: Point = {
        ts, cpu: m.cpu, mem_used: m.mem_used, disk_used: m.disk_used,
        net_rx: m.net_rx, net_tx: m.net_tx, swap_used: m.swap_used,
        tcp: m.tcp, udp: m.udp, procs: m.procs,
      }
      return [...rows, point].filter((r) => r.ts > ts - LIVE_WINDOW)
    })
    // oxlint-disable-next-line react/set-state-in-effect
    setUpdatedAt(Date.now())
  }, [isLive, node.metrics])

  // 每条上报过的探测一个序列（node prop 每 2 秒一换，useMemo 免得丢拖选）
  const pingSeries = useMemo(
    () =>
      [...new Set((data?.ping ?? []).map((p) => p.task_id))]
        .map((id) => {
          // 超时桶保留（丢了它们，半丢包的探测会被画成健康线）丢包率取 hub 下发的
          // 整窗值，不从桶里的百分比平均
          const points = (data?.ping ?? []).filter((p) => p.task_id === id)
          const loss = data?.loss?.[id] ?? 0
          return { id, name: data?.probes?.[id] ?? `探测 ${id}`, points, loss }
        })
        .filter((s) => s.points.length > 0),
    [data],
  )

  // 时间转换与新历史字段的有效性判断共用一次遍历，旧 Hub 的缺字段保留为断点
  const { rows: metricRows, available, peaks } = useMemo(
    () => resourceHistory(isLive ? liveRows : data?.metrics ?? []),
    [isLive, liveRows, data],
  )
  const stepMs = isLive ? LIVE_GAP_MS : typeof data?.step === "number" ? data.step * 1_000 : undefined
  const missingHistory = [
    !available.swap_used && "Swap",
    !available.tcp && "TCP",
    !available.udp && "UDP",
    !available.procs && "进程数",
  ].filter(Boolean).join("、")

  // 轴顶：CPU 与速率没有「容量」可言（钉死 0-100 会把 0.4% 画成贴地板），
  // 内存与硬盘则以容量为顶——占用比例才是全部问题
  const tops = useMemo(() => {
    const max = (pick: (m: Point) => number) =>
      metricRows.reduce((hi, m) => Math.max(hi, pick(m)), 0)
    // 内存与 Swap 合用一张图、一条轴：轴顶要同时盖住两台容量与窗口峰值
    const memPeak = Math.max(max((m) => m.mem_used), peaks.swap_used, node.swap_total)
    return {
      // 4% 起步、封顶 100：不然常年 0.4% 的机器会把每次调度尖峰画成峰
      cpu: axisTop(max((m) => m.cpu), 4, 10, 100),
      rate: axisTop(max((m) => Math.max(m.net_rx, m.net_tx)), 1024, 1024),
      memory: memPeak > node.mem_total ? axisTop(memPeak, 1024, 1024) : node.mem_total,
      disk: max((m) => m.disk_used),
      connections: countAxisTop(Math.max(peaks.tcp, peaks.udp)),
      procs: countAxisTop(peaks.procs),
    }
  }, [metricRows, peaks, node.mem_total, node.swap_total])

  const shownProbes = useMemo(
    () => pingSeries.filter((s) => !hiddenProbes.includes(s.id)),
    [pingSeries, hiddenProbes],
  )
  // 色号按全表顺序取（不按可见列表），藏掉别的线不影响自己的色
  const style = (id: number) => PALETTE[pingSeries.findIndex((p) => p.id === id) % PALETTE.length]

  // 每个探测一列（t=原始、s=削峰、b/c=区间、l=丢包、tu/su/bu/cu=丢包断点版）：
  // 所有列都留在同一张宽表里，隐藏探测或开关削峰只是换 `dataKey`，不重建数组
  const pingRows = useMemo(() => {
    const rows = new Map<
      number,
      { ts: number } & Record<string, number | [number, number] | null>
    >()
    for (const s of pingSeries) {
      const windowSize = despikeWindow(s.points)
      const smoothed = despike(s.points.map((p) => p.latency), windowSize)
      // 区间与线走同一套削峰，免得离群点把轴拉宽
      const lo = despike(s.points.map((p) => p.band?.[0] ?? p.latency), windowSize)
      const hi = despike(s.points.map((p) => p.band?.[1] ?? p.latency), windowSize)
      s.points.forEach((p, i) => {
        const row = rows.get(p.ts) ?? { ts: p.ts * 1_000 }
        row[`t${s.id}`] = p.latency
        row[`s${s.id}`] = smoothed[i]
        row[`l${s.id}`] = p.loss ?? 0
        // 单答案的桶没有 band，就用自己的延迟补一对；全超时留 null 断开
        row[`b${s.id}`] = p.band ?? (p.latency === null ? null : [p.latency, p.latency])
        // 两条边独立削峰可能交叉，取三条序列的包络
        const [low, high] = [lo[i], hi[i]]
        row[`c${s.id}`] =
          low === null || high === null
            ? null
            : [Math.min(low, high, smoothed[i] ?? low), Math.max(low, high, smoothed[i] ?? high)]
        // 有丢包的桶当断点：合桶后只要有一个超时，线连过去会把「半丢包」画成健康线路
        // 绘制用 tu/su/bu/cu 断点列，tooltip 仍读 t/s/l 原始值
        const lost = (p.loss ?? 0) > 0
        row[`tu${s.id}`] = lost ? null : p.latency
        row[`su${s.id}`] = lost ? null : smoothed[i]
        row[`bu${s.id}`] = lost ? null : row[`b${s.id}`]
        row[`cu${s.id}`] = lost ? null : row[`c${s.id}`]
        rows.set(p.ts, row)
      })
    }
    return [...rows.values()].sort((a, b) => a.ts - b.ts)
  }, [pingSeries])

  // 延迟 tooltip 按时间戳回查整行（丢包率挂在同一行的另一列上）
  const rowByTs = useMemo(() => new Map(pingRows.map((row) => [row.ts, row])), [pingRows])
  const zoomIndices = timeRangeIndices(pingRows, zoom)

  // 每张资源图各记一段拖选（时间戳）：live 追加或刷新后仍看同一段时间，
  // 选区滑出窗口就回 null（全图）
  const chartZoom = (key: string) => {
    const indices = timeRangeIndices(metricRows, resourceZoom[key] ?? null)
    return {
      from: indices?.[0] ?? 0,
      to: indices?.[1] ?? metricRows.length - 1,
      onZoom: (from: number, to: number) =>
      setResourceZoom((z) => ({
        ...z,
        [key]: from === 0 && to === metricRows.length - 1 ? null : [metricRows[from].ts, metricRows[to].ts],
      })),
    }
  }

  // 资源页签的六张卡（实时与历史档共用）：Swap 并进内存那张图；每张可拖选细看
  const resourceCharts = (
    <div className="grid grid-cols-1 gap-y-5 sm:grid-cols-2 sm:gap-x-4">
      {missingHistory && (
        <p className="text-xs text-muted-foreground sm:col-span-2">
          当前 Hub 或这段历史未提供 {missingHistory} 数据
        </p>
      )}
      <Panel title="CPU">
        <TimeChart
          rows={metricRows}
          series={[{ key: "cpu", name: "CPU", color: "var(--chart-1)", area: true }]}
          hours={hours}
          step={stepMs}
          top={tops.cpu}
          unit="%"
          format={(v) => `${v.toFixed(1)}%`}
          label="CPU 使用率走势"
          {...chartZoom("cpu")}
        />
      </Panel>

      {/* 轴顶是机器的内存（盖不住时走整齐刻度），所以内存那条线的高度就是占用的比例；
          Swap 是同一条轴上的第二条线，量纲相同、容量写在标题里 */}
      <Panel
        title={`内存 · ${bytes(node.mem_total)}${node.swap_total > 0 ? ` · Swap ${bytes(node.swap_total)}` : ""}`}
      >
        <TimeChart
          rows={metricRows}
          series={[
            { key: "mem_used", name: "内存", color: "var(--chart-4)", area: true },
            ...(available.swap_used ? [{ key: "swap_used", name: "Swap", color: "var(--chart-5)" }] : []),
          ]}
          hours={hours}
          step={stepMs}
          top={tops.memory}
          yFormat={axisBytes}
          format={(v) => bytes(v)}
          label="内存 / Swap 使用量走势"
          {...chartZoom("memory")}
        />
      </Panel>

      {/* 速率没有容量可言，与 CPU 一样爬阶梯而不是钉在容量上 */}
      <Panel title="网络速率">
        <TimeChart
          rows={metricRows}
          series={[
            { key: "net_rx", name: "下行", color: "var(--ok)" },
            { key: "net_tx", name: "上行", color: "var(--chart-2)" },
          ]}
          hours={hours}
          step={stepMs}
          top={tops.rate}
          unit="/s"
          yFormat={axisBytes}
          format={(v) => rate(v)}
          label="网络速率走势"
          {...chartZoom("rate")}
        />
      </Panel>

      <Panel title={`硬盘 · ${bytes(node.disk_total)}`}>
        <TimeChart
          rows={metricRows}
          series={[{ key: "disk_used", name: "硬盘", color: "var(--chart-3)", area: true }]}
          hours={hours}
          step={stepMs}
          top={tops.disk > node.disk_total ? axisTop(tops.disk, 1024, 1024) : node.disk_total}
          yFormat={axisBytes}
          format={(v) => bytes(v)}
          label="硬盘使用量走势"
          {...chartZoom("disk")}
        />
      </Panel>

      {(available.tcp || available.udp) && (
        <Panel title="连接数 · TCP / UDP">
          <TimeChart
            rows={metricRows}
            series={[
              ...(available.tcp ? [{ key: "tcp", name: "TCP", color: "var(--chart-6)" }] : []),
              ...(available.udp ? [{ key: "udp", name: "UDP", color: "var(--chart-7)", dash: "4 3" }] : []),
            ]}
            hours={hours}
            step={stepMs}
            top={tops.connections}
            yFormat={String}
            format={String}
            label="TCP / UDP 连接数走势"
            {...chartZoom("connections")}
          />
        </Panel>
      )}

      {available.procs && (
        <Panel title="进程数">
          <TimeChart
            rows={metricRows}
            series={[{ key: "procs", name: "进程", color: "var(--chart-8)", area: true }]}
            hours={hours}
            step={stepMs}
            top={tops.procs}
            yFormat={String}
            format={String}
            label="进程数走势"
            {...chartZoom("procs")}
          />
        </Panel>
      )}
    </div>
  )

  return (
    <div className="space-y-4">
      {/* 就地展开（紧凑形态点开一行）时不重复身份行与规格：那一行在表格里已报过名字 */}
      {!embedded && (
      <>
      <div className="flex items-center gap-2">
        <Country node={node} />
        <h2 className="truncate text-lg font-medium">{node.name}</h2>
      </div>

      <dl className="grid gap-x-6 gap-y-3 md:grid-cols-2 lg:grid-cols-3">
        <Fact label="系统" value={[osName(node.os), node.kernel].filter(Boolean).join(" · ")} />
        <Fact
          label="CPU"
          value={node.cpu_name ? `${cpuName(node.cpu_name)} × ${node.cpu_cores}` : `${node.cpu_cores} 核`}
        />
        <Fact label="内存 / 硬盘" value={`${bytes(node.mem_total)} / ${bytes(node.disk_total)}`} />
        <Fact
          label="架构"
          value={[node.arch, node.virt !== "none" ? node.virt : ""].filter(Boolean).join(" · ")}
        />
        <Fact label="今日流量" value={`↓ ${bytes(node.day_rx)} · ↑ ${bytes(node.day_tx)}`} />
        <Fact label="在线时间" value={onlineFor(node)} />
      </dl>

      {/* 整页详情的备注：私有 + 公有小卡片，直接落在页面上；没写备注时不占位 */}
      {detailChips.length > 0 && (
        <div data-remark-block className="flex min-w-0 flex-wrap items-center gap-1">
          <RemarkChips chips={detailChips} />
        </div>
      )}
      </>
      )}

      <div className={embedded ? "space-y-2" : "space-y-2 border-t pt-4"}>
        {!embedded && (
        <div className="flex gap-1">
          {TABS.map((t) => (
            <Tab key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}
            </Tab>
          ))}
        </div>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex gap-1">
            {/* 资源页签的默认档：快照 + 最近十分钟垫底 */}
            {tab === "resources" && (
              <Tab key="live" active={resourceRange === "live"} onClick={() => setResourceRange("live")}>
                实时
              </Tab>
            )}
            {RANGES.map((r) => (
              <Tab
                key={r.hours}
                active={tab === "latency" ? latencyRange === r.hours : resourceRange === r.hours}
                onClick={() => (tab === "latency" ? setLatencyRange(r.hours) : setResourceRange(r.hours))}
              >
                {r.label}
              </Tab>
            ))}
          </div>
          {tab === "latency" && (<>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={smooth}
                onChange={(e) => setSmooth(e.target.checked)}
                className="accent-foreground"
              />
              削峰
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground" title="跨过丢包或缺测样本连接有效延迟点；不补写延迟数据">
              <input
                type="checkbox"
                data-latency-option="connect-gaps"
                checked={connectGaps}
                onChange={(e) => chooseLatencyStyle(latencyStyleFromOptions({ connectGaps: e.target.checked, smooth: smoothLines }))}
                className="accent-foreground"
              />
              连接断点
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground" title="让曲线平滑经过有效采样点；不改变采样值，也不替代削峰">
              <input
                type="checkbox"
                data-latency-option="smooth-lines"
                checked={smoothLines}
                onChange={(e) => chooseLatencyStyle(latencyStyleFromOptions({ connectGaps, smooth: e.target.checked }))}
                className="accent-foreground"
              />
              平滑曲线
            </label>
            {latencyStyle !== siteDefault && (
              <button
                type="button"
                onClick={() => chooseLatencyStyle(siteDefault)}
                className="shrink-0 whitespace-nowrap text-xs text-muted-foreground transition-colors hover:text-foreground"
                title="恢复主题设置中的延迟曲线样式"
              >
                恢复默认
              </button>
            )}
          </>)}
          {/* 备注在紧凑展开行的右端：桌面并排，手机收成一枚小图标 + 浮层
              整页详情不挂这条入口（那页已整串摊开，免得出现两遍） */}
          {embedded && (cardChips.length > 0 || onOpenDetail) && (
            <span className="ml-auto flex w-full min-w-0 items-center justify-end gap-x-4 gap-y-1 sm:w-auto sm:flex-1">
              {cardChips.length > 0 && (
                <>
                  <span data-note-strip className="hidden min-w-0 flex-1 items-center justify-end gap-1 overflow-hidden sm:flex">
                    <RemarkChips chips={cardChips} />
                  </span>
                  <span
                    ref={peekRef}
                    className="relative inline-flex items-center sm:hidden"
                    onPointerEnter={(e) => { if (e.pointerType === "mouse") setPeekOpen(true) }}
                    onPointerLeave={(e) => { if (e.pointerType === "mouse") setPeekOpen(false) }}
                  >
                    <button
                      data-note-popover
                      aria-expanded={peekOpen}
                      aria-label={`备注：${cardChips.map((c) => c.text).join("、")}`}
                      onClick={(e) => {
                        // 点它不该连带开合那一行
                        e.stopPropagation()
                        setPeekOpen((open) => !open)
                      }}
                      // 只拦「激活键」的冒泡，Esc 必须放它上去
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation() }}
                      className="inline-flex text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Info className="size-3.5" />
                    </button>
                    {peekOpen && (
                      <span
                        data-note-panel
                        role="tooltip"
                        className="absolute top-5 right-0 z-20 flex w-max max-w-[16rem] flex-wrap gap-1 rounded-md border bg-card px-2 py-1.5 shadow-md"
                      >
                        <RemarkChips chips={cardChips} />
                      </span>
                    )}
                  </span>
                </>
              )}
              {onOpenDetail && (
                <button onClick={onOpenDetail} className="shrink-0 whitespace-nowrap text-xs text-muted-foreground transition-colors hover:text-foreground">
                  完整详情 ›
                </button>
              )}
            </span>
          )}
        </div>
        {(updatedAt > 0 || refreshing) && (
          <p className="text-[11px] text-muted-foreground" role="status">
            {updatedAt > 0 && <span title={new Date(updatedAt).toLocaleString("zh-CN")}>{isLive ? "实时更新于" : "历史更新于"} {new Date(updatedAt).toLocaleTimeString("zh-CN")}</span>}
            {refreshing && <span>{updatedAt > 0 ? " · " : ""}刷新中…</span>}
          </p>
        )}
        {failed && updatedAt > 0 && (
          <p className="text-xs text-destructive" role="alert">
            刷新失败：{failed}；当前保留上次结果<button className="ml-1 underline" onClick={() => reload.current()}>重试</button>
          </p>
        )}
      </div>

      {tab === "latency" ? (
        !data ? (
          <Skeleton className="h-40 w-full" />
        ) : failed && updatedAt === 0 ? (
          <p className="py-8 text-center text-sm text-destructive" role="alert">读取历史数据失败：{failed} <button className="underline" onClick={() => reload.current()}>重试</button></p>
        ) : pingSeries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">这段时间没有延迟数据</p>
        ) : (
          // 外层给显式像素高，图才能 `flex-1`、图例按需占行
          <div
            // `+ scrollY`：getBoundingClientRect 量的是视口坐标，而 live 节点每 2 秒重渲一次
            ref={(el) => {
              // 就地展开时高度写死，不再按视口撑满：它下面还压着别的行
              if (el && !embedded) setChartTop(el.getBoundingClientRect().top + scrollY)
            }}
            style={
              !embedded && chartTop
                ? { height: `calc(100svh - ${Math.round(chartTop)}px - 1rem)` }
                : undefined
            }
            className={embedded ? "flex h-72 flex-col gap-3" : "flex min-h-72 flex-col gap-3"}>
            {/* `min-h-0` 让 `flex-1` 是真数字而不是内容自身高度 */}
            <div className="min-h-0 w-full flex-1 text-muted-foreground">
              {shownProbes.length === 0 ? (
                <p className="py-8 text-center text-sm">没有选中任何探测</p>
              ) : (
                <TimeChart
                  rows={pingRows}
                  series={[
                    // 区间（band）只在屏上只有一个探测时画：几个叠在一起会糊成一片
                    ...(shownProbes.length === 1
                      ? shownProbes.map((s) => ({
                          key: `${smooth ? "cu" : "bu"}${s.id}`,
                          name: s.name,
                          color: style(s.id).stroke,
                          band: true,
                        }))
                      : []),
                    ...shownProbes.map((s) => ({
                      key: `${smooth ? "su" : "tu"}${s.id}`,
                      name: s.name,
                      color: style(s.id).stroke,
                      dash: style(s.id).dash,
                    })),
                  ]}
                  hours={hours}
                  step={stepMs}
                  // 延迟轴不从 0 起：这些线路活在一条窄带里，锚到 0 会把起伏压平
                  domain="auto"
                  unit="ms"
                  left={52}
                  connectGaps={connectGaps}
                  smoothLines={smoothLines}
                  from={zoomIndices?.[0] ?? 0}
                  to={zoomIndices?.[1] ?? pingRows.length - 1}
                  onZoom={(from, to) => setZoom(from === 0 && to === pingRows.length - 1 ? null : [pingRows[from].ts, pingRows[to].ts])}
                  label="节点延迟走势"
                  renderTooltip={(row) => (
                    <PingTooltip active label={row.ts} rowByTs={rowByTs} probes={shownProbes} smooth={smooth} style={style} />
                  )}
                />
              )}
            </div>

            {/* 图下的探测开关：点一枚隐/显一条线，轴随剩余的线重定标 */}
            {(pingSeries.length > 1 || pingSeries.some((s) => s.loss > 0 || hiddenProbes.includes(s.id))) && (
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {pingSeries.map((s) => {
                const shown = !hiddenProbes.includes(s.id)
                return (
                  <button
                    key={s.id}
                    onClick={() =>
                      setHiddenProbes((h) => (shown ? [...h, s.id] : h.filter((id) => id !== s.id)))
                    }
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-opacity ${
                      shown ? "" : "opacity-40"
                    }`}
                  >
                    <svg width="14" height="6" className="shrink-0" aria-hidden>
                      <line
                        x1="0"
                        y1="3"
                        x2="14"
                        y2="3"
                        stroke={style(s.id).stroke}
                        strokeDasharray={style(s.id).dash}
                        strokeWidth="2"
                      />
                    </svg>
                    {s.name}
                    {/* 线只画答上来的，丢包另标一枚 */}
                    {s.loss > 0 && (
                      <span className="tabular-nums opacity-60">
                        丢 {s.loss < 1 ? "<1" : Math.round(s.loss)}%
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
            )}
          </div>
        )
      ) : isLive ? (
        liveRows.length === 0 && !liveSeeded ? (
          <Skeleton className="h-40 w-full" />
        ) : metricRows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">暂无实时数据</p>
        ) : (
          resourceCharts
        )
      ) : !data ? (
        <Skeleton className="h-40 w-full" />
      ) : failed && updatedAt === 0 ? (
        <p className="py-8 text-center text-sm text-destructive" role="alert">读取历史数据失败：{failed} <button className="underline" onClick={() => reload.current()}>重试</button></p>
      ) : metricRows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">这段时间没有历史数据</p>
      ) : (
        resourceCharts
      )}
    </div>
  )
}
