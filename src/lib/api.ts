import { useEffect, useState } from "react"
import { recordNodeSpeeds } from "./speed-history.ts"
import { ApiError, requestJSON, startNodeTransport } from "./transport.ts"
export { ApiError } from "./transport.ts"

export type Metrics = {
  uptime: number
  cpu: number
  load: [number, number, number]
  mem_total: number
  mem_used: number
  swap_total: number
  swap_used: number
  disk_total: number
  disk_used: number
  net_rx: number
  net_tx: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  tcp: number
  udp: number
  procs: number
}

export type Node = {
  id: number
  name: string
  sort: number
  public: boolean
  online: boolean
  /** ISO 3166-1 alpha-2；hub 定不到地址时是空串 */
  country: string
  /** 站长设的分组；空串 = 未分组，老 hub 没有这个键 */
  group?: string
  /**
   * 站长在后台写给访客的一行说明（单行、≤100 字，留空是空串）hub 1.3.2 起随**公开视图**
   * 一起下发，所以匿名也拿得到——与最下面那个私有的 `remark` 不是一回事老 hub 没有这个键
   */
  public_remark?: string | null
  last_seen: number
  /** 按 hub 时钟算的距上次上报秒数；首次上报前是 null，老 hub 没有这个键 */
  last_seen_ago?: number | null
  metrics: Metrics | null
  os: string
  kernel: string
  arch: string
  virt: string
  cpu_name: string
  cpu_cores: number
  mem_total: number
  swap_total: number
  disk_total: number
  agent_version: string
  price: number
  currency: string
  billing_cycle: string
  expires_at: string | null
  /** 按 hub 日历算的距 `expires_at` 天数，过期为负；没有日期是 null 老 hub 没有这个键 */
  expires_in?: number | null
  traffic_limit: number
  traffic_mode: string
  traffic_reset_day: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  /** 本计费周期的用量（按 `traffic_mode` 口径）老 hub 没有这个键 */
  month_used?: number
  month_start: string
  day_rx: number
  day_tx: number
  /** 仅面板可见 */
  hostname?: string
  ip?: string
  remark?: string
}

/** 全部在用的分组，按首个携带它的节点排序：站点的节点顺序决定标签顺序 */
export function groupsOf(nodes: Pick<Node, "group">[]): string[] {
  return [...new Set(nodes.map((n) => n.group ?? "").filter(Boolean))]
}

/**
 * 分组筛选的一次求值：把「选中的那一档」归一化，并给出要显示的节点、标签行的内容与总台数
 *
 * 归一化：选中的分组被改名/解散、或「未分组」里已经没人了，都回落「全部」而不是停在一个
 * 什么都看不见的筛选上，且不记住——以后出现同名分组也不会自己接手这个页面
 * 标签行整行关掉（listTop 不含 groups）时 `current` 恒为 null：站长一关，访客手里的
 * 分组选中态就作废
 *
 * ★App 与 NodeList 读**同一次**求值：概览卡片与下面的列表都取 `shown`，两边不可能
 * 各说一套（参考站内置 default 主题的概览四格也是拿筛选后的节点）
 */
export function groupView(nodes: Node[], group: string | null, showTabs: boolean) {
  const groups = groupsOf(nodes)
  const ungrouped = nodes.filter((n) => !n.group).length
  const current = !showTabs ? null : group === null || (group === "" ? ungrouped > 0 : groups.includes(group)) ? group : null
  const shown = current === null ? nodes : nodes.filter((n) => (n.group ?? "") === current)
  const tabs = [
    [null, "全部", nodes.length] as const,
    ...groups.map((g) => [g, g, nodes.filter((n) => n.group === g).length] as const),
    ...(ungrouped ? [["", "未分组", ungrouped] as const] : []),
  ]
  return { groups, ungrouped, current, shown, tabs, total: nodes.length, showTabs }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJSON<T>(`/api${path}`, init)
}

/**
 * 吞吐量按每次推送记一个样本：全站一个序列（null 键）、每个分组一个序列（"" = 未分组），
 * 分组标签上方的概览才画得出这一组的线而不是全站的 放在喂数据的流旁边而不是画图
 * 的卡片里：节点页打开时概览会卸载，缓存放在那里每次回来都是空的保留两分钟
 * （按 hub 推送间隔）；没节点再携带的组会掉 全站用 null 键而不是任何字符串 ——
 * 分组可能叫任何名字，包括 "*"
 */
const KEEP = 60
export const speedHistory = new Map<string | null, { rx: number; tx: number }[]>()

export function sample(nodes: Node[]) {
  recordNodeSpeeds(nodes)
  const totals = new Map<string | null, { rx: number; tx: number }>()
  for (const n of nodes) {
    for (const key of [null, n.group ?? ""]) {
      const total = totals.get(key) ?? { rx: 0, tx: 0 }
      if (n.online && n.metrics) {
        total.rx += n.metrics.net_rx
        total.tx += n.metrics.net_tx
      }
      totals.set(key, total)
    }
  }
  for (const key of speedHistory.keys()) if (!totals.has(key)) speedHistory.delete(key)
  for (const [key, total] of totals) {
    const series = speedHistory.get(key) ?? []
    series.push(total)
    if (series.length > KEEP) series.shift()
    speedHistory.set(key, series)
  }
}

/** 一条坏掉的上报不许把其他节点从页面上挤掉 */
export function safeNodes(nodes: unknown): Node[] {
  if (!Array.isArray(nodes)) throw new Error("节点数据格式错误")
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0
  const fields = ["uptime", "cpu", "mem_total", "mem_used", "swap_total", "swap_used", "disk_total", "disk_used",
    "net_rx", "net_tx", "total_rx", "total_tx", "month_rx", "month_tx", "tcp", "udp", "procs"] as const
  return nodes.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || !Number.isSafeInteger(raw.id) || raw.id <= 0) return []
    const node = raw as Node
    const safe = { ...node }
    for (const key of ["name", "country", "os", "kernel", "arch", "virt", "cpu_name", "agent_version",
      "currency", "billing_cycle", "traffic_mode", "month_start"] as const) {
      if (typeof safe[key] !== "string") safe[key] = ""
    }
    // 老 hub 会缺可选字段；只归一化实际存在的键
    for (const key of ["group", "public_remark", "remark", "hostname", "ip"] as const) {
      if (safe[key] != null && typeof safe[key] !== "string") safe[key] = ""
    }
    if (!/^[A-Za-z]{2}$/.test(safe.country)) safe.country = ""
    for (const key of ["last_seen", "cpu_cores", "mem_total", "swap_total", "disk_total", "price", "traffic_limit",
      "traffic_reset_day", "total_rx", "total_tx", "month_rx", "month_tx", "day_rx", "day_tx"] as const) {
      if (!number(safe[key])) safe[key] = 0
    }
    if (safe.month_used !== undefined && !number(safe.month_used)) delete safe.month_used
    if (safe.last_seen_ago !== undefined && safe.last_seen_ago !== null && !number(safe.last_seen_ago)) delete safe.last_seen_ago
    if (typeof safe.expires_in !== "number" || !Number.isFinite(safe.expires_in)) delete safe.expires_in
    if (typeof safe.expires_at !== "string") safe.expires_at = null
    if (typeof safe.sort !== "number" || !Number.isFinite(safe.sort)) safe.sort = 0
    safe.online = safe.online === true
    safe.public = safe.public === true
    const m = safe.metrics
    safe.metrics = m && typeof m === "object" && fields.every((key) => number(m[key])) &&
      Array.isArray(m.load) && m.load.length === 3 && m.load.every(number) ? m : null
    return [Object.keys(safe).every((key) => safe[key as keyof Node] === node[key as keyof Node]) &&
      Object.keys(safe).length === Object.keys(node).length ? node : safe]
  })
}

/**
 * 实时节点列表：走 hub 每 2 秒推一次的 WebSocket，建不起来时回退轮询
 */
export function useNodes() {
  const [nodes, setNodes] = useState<Node[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // hub 答 401 时置位：状态页从本标签页加载起就对匿名访客关闭了hub 也会断流，
  // 所以它落在重连发起的那次回退 fetch 上；断开只允许客户端重查状态、不能强迫它
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`
    const readNodes = (data: unknown) => {
      if (!data || typeof data !== "object" || !Array.isArray((data as { nodes?: unknown }).nodes)) {
        throw new Error("节点数据格式错误")
      }
      return safeNodes((data as { nodes: unknown[] }).nodes)
    }
    return startNodeTransport({
      fetchNodes: (signal) => api<unknown>("/nodes", { signal }).then(readNodes),
      openSocket: () => new WebSocket(url),
      parseMessage: (data) => readNodes(JSON.parse(data)),
      receive: (safe) => {
        sample(safe)
        setNodes(safe)
        setError(null)
        setClosed(false)
      },
      fail: (error) => {
        setError(error instanceof Error ? error.message || "网络错误" : "网络错误")
        if (error instanceof ApiError && error.status === 401) setClosed(true)
      },
    })
  }, [])

  return { nodes, error, closed }
}
