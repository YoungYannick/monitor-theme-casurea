import { Card } from "@/components/ui/card"
import { Country, OfflineMark, RemarkChips, deployed, monthUsage } from "@/components/NodeCard"
import { TextHighlight } from "@/components/TextHighlight"
import type { Node } from "@/lib/api"
import { CYCLE_SHORT, FOREVER, bytes, daysUntil, money, osName, pair, percent, rate, uptime } from "@/lib/format"
import { remarkChips } from "@/lib/notes"
import { remarksOnCards, type RemarkPlacement } from "@/lib/site-settings"

/**
 * 「宽卡」那一档：横向大卡，列数交给本主题的 auto-fill 网格自适应（wide 档每张下限 450px，
 * 能放几张放几张，不写死参考站那样的 1080 两列）从上到下六块：① 身份行 ② 系统·运行时间
 * ③ 四读数格 ④ 上传/下载 ⑤ 总流量 ⑥ 底注（价格 / 到期 + 备注）
 *
 * 风格与其余档同一套口径：不带状态点、不带「已离线」徽章（在线与否写在②那行文字里）；读数条
 * 用前景色 70%；卡面不含延迟、不挂信息图标 底注那行**恒定占位**（16px），备注小卡片收成紧凑档
 */

/** 名字下面那行灰字：系统 · 运行时间 离线 / 未接入 / 连上未上报四种处境各自说得清 */
function metaLine(node: Node): string {
  const state = node.metrics
    ? `运行时间 ${uptime(node.metrics.uptime)}`
    : node.online ? "在线" : deployed(node) ? "已离线" : "未接入"
  return [osName(node.os), state].filter(Boolean).join(" · ")
}

/** 负载那一格的条：`load[0] / 核数`＝满载的几成；核数取不到时按 1 核算 */
function loadPct(node: Node): number | null {
  const m = node.metrics
  return m ? percent(m.load[0], Math.max(1, node.cpu_cores || 1)) : null
}

/** 底注那行小字：价格 / 周期 · 剩余天数 免费与无期限都有占位（「免费」「无期限」，同账单页
 *  与其他卡片档的口径），不空着 */
function noteText(node: Node): string {
  const cycle = CYCLE_SHORT[node.billing_cycle]
  const price = node.price > 0 ? `价格 ${money(node.price, node.currency)}${cycle ? `/${cycle}` : ""}` : "免费"
  const days = node.expires_in !== undefined ? node.expires_in : daysUntil(node.expires_at)
  const left = days === null || days === undefined ? "无期限"
    : days < 0 ? `已过期 ${-days} 天` : days === 0 ? "今天到期" : `剩余 ${days} 天`
  return `${price} · ${left}`
}

// 流量按套餐自己的计流量方式算，进度条才与计费额度对得上
function trafficFoot(node: Node) {
  return node.traffic_limit > 0
    ? pair(monthUsage(node), node.traffic_limit)
    : `${bytes(monthUsage(node))} / ${FOREVER}`
}

/** 底注那一行最多摊几枚备注小卡片（一行放不下，把价格/到期挤走就见不到了） */
const CHIPS = 3

/** 一个读数格：表名在上、读数在中、3px 条压底 `pct` 为 null 时轨道留空（「不知道」≠「用得很少」） */
function Readout({ label, value, pct, title }: { label: string; value: string; pct: number | null; title?: string }) {
  const filled = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="min-w-0" title={title}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="tnum mt-0.5 truncate text-[13px] font-semibold leading-[18px]">{value}</div>
      <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-500" style={{ width: `${filled}%` }} />
      </div>
    </div>
  )
}

export function WideCard({ node, onOpen, onWarm, terms, remarkPlacement, selected }: {
  node: Node
  onOpen: () => void
  onWarm?: () => void
  /** 搜索命中词：名字里描色 没在搜时是空数组 */
  terms?: string[]
  remarkPlacement?: RemarkPlacement
  /** 键盘光标停在这张卡上：加一圈描边 */
  selected?: boolean
}) {
  const m = node.metrics
  const chips = remarksOnCards(remarkPlacement ?? "both") ? remarkChips(node).slice(0, CHIPS) : []
  // 已部署但掉线：挂离线标记（未接入的不算，见 OfflineMark）
  const offline = !node.online && deployed(node)
  return (
    <Card
      onClick={onOpen}
      onPointerOver={onWarm}
      onFocus={onWarm}
      onTouchStart={onWarm}
      data-node-card={node.id}
      data-selected={selected ? "1" : undefined}
      className={`min-w-0 cursor-pointer gap-0 px-4 py-3 transition-colors hover:border-foreground/25${offline ? " relative" : ""} ${selected ? "outline-2 outline-offset-1 outline-ring" : ""}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
    >
      {/* ① 身份行：旗子 + 名字（搜索命中处描色） */}
      <div className="flex min-w-0 items-center gap-2">
        <Country node={node} />
        <h3 className="min-w-0 flex-1 truncate font-semibold leading-5"><TextHighlight text={node.name} terms={terms} /></h3>
      </div>

      {/* ② 系统 · 运行时间一行灰字 */}
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{metaLine(node)}</p>

      {deployed(node) ? (
        <>
          {/* ③ 四个读数格（CPU / 内存 / 存储 / 负载） */}
          <div data-metrics="" className="mt-1.5 grid grid-cols-4 gap-x-3 border-t pt-1.5">
            <Readout
              label="CPU"
              title={`${node.cpu_cores} 核`}
              pct={m ? m.cpu : null}
              value={m ? `${m.cpu.toFixed(2)}%` : "—"}
            />
            <Readout
              label="内存"
              title={m ? pair(m.mem_used, m.mem_total) : bytes(node.mem_total)}
              pct={m ? percent(m.mem_used, m.mem_total) : null}
              value={m ? `${percent(m.mem_used, m.mem_total).toFixed(2)}%` : "—"}
            />
            <Readout
              label="存储"
              title={m ? pair(m.disk_used, m.disk_total) : bytes(node.disk_total)}
              pct={m ? percent(m.disk_used, m.disk_total) : null}
              value={m ? `${percent(m.disk_used, m.disk_total).toFixed(2)}%` : "—"}
            />
            <Readout
              label="负载"
              title={m ? `1 / 5 / 15 分钟：${m.load.map((n) => n.toFixed(2)).join(" ")}` : undefined}
              pct={loadPct(node)}
              value={m ? m.load[0].toFixed(2) : "—"}
            />
          </div>

          {/* ④ 上传 / 下载两栏 */}
          <div data-net="duo" className="mt-1.5 grid grid-cols-2">
            <div className="min-w-0 pr-3">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="shrink-0"><span className="text-muted-foreground">↑</span> 上传</span>
                <span className="tnum min-w-0 truncate text-muted-foreground">累计 {bytes(node.total_tx)}</span>
              </div>
              <div className="tnum mt-0.5 truncate text-base font-semibold leading-[18px]">{m ? rate(m.net_tx) : "—"}</div>
            </div>
            <div className="min-w-0 border-l pl-3">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="shrink-0"><span className="text-muted-foreground">↓</span> 下载</span>
                <span className="tnum min-w-0 truncate text-muted-foreground">累计 {bytes(node.total_rx)}</span>
              </div>
              <div className="tnum mt-0.5 truncate text-base font-semibold leading-[18px]">{m ? rate(m.net_rx) : "—"}</div>
            </div>
          </div>

          {/* ⑤ 总流量：已用 / 额度 + 重置日 + 全宽进度条 */}
          <div className="tnum mt-1.5 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="min-w-0 truncate">{trafficFoot(node)}</span>
            <span className="shrink-0">
              流量重置：{node.traffic_limit > 0 ? `每月 ${node.traffic_reset_day} 日` : "N/A"}
            </span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground/70 transition-[width] duration-500"
              style={{ width: `${node.traffic_limit > 0 ? percent(monthUsage(node), node.traffic_limit) : 0}%` }}
            />
          </div>

          {/* ⑥ 底注：价格 / 到期在左、备注在右，这一行恒定占位（16px） */}
          <div className="mt-1.5 flex h-4 min-w-0 items-center justify-between gap-2">
            <span className="tnum min-w-0 truncate text-[11px] leading-4 text-muted-foreground">{noteText(node)}</span>
            <span data-remark="card" className="flex min-w-0 shrink items-center justify-end gap-1">
              <RemarkChips chips={chips} compact />
            </span>
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          还没有接入 在后台生成安装命令并执行一次
        </p>
      )}
      {offline && <OfflineMark />}
    </Card>
  )
}