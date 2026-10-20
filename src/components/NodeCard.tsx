import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react"
import {
  ArrowDown, ArrowDownUp, ArrowUp, CalendarClock, Cpu, HardDrive, Info, Lock, MemoryStick,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { LatencyPanel, PeekLatency } from "@/components/Latency"
import { Meter } from "@/components/Meter"
import { TextHighlight } from "@/components/TextHighlight"
import { WideCard } from "@/components/WideCard"
import type { Node } from "@/lib/api"
import { CYCLES, FOREVER, bytes, daysUntil, money, offlineSeconds, pair, percent, rate, uptime } from "@/lib/format"
import { remarkChips, type RemarkChip } from "@/lib/notes"
import { remarksOnCards, type RemarkPlacement } from "@/lib/site-settings"

/**
 * This period's usage as the plan meters it. The hub computes it; the switch
 * below serves only a hub from before `month_used`.
 */
export function monthUsage(node: Node): number {
  if (typeof node.month_used === "number") return node.month_used
  const { month_rx: rx, month_tx: tx } = node
  switch (node.traffic_mode) {
    case "up":
      return tx
    case "down":
      return rx
    case "max":
      return Math.max(rx, tx)
    default:
      return rx + tx
  }
}

// A node that has reported once has told the hub its shape -- cores, memory,
// disk -- and the hub retains its traffic totals whether connected or not. A node
// that never connected is the only case with nothing to show.
export function deployed(node: Node) {
  return node.cpu_cores > 0 || node.mem_total > 0
}

/**
 * 离线标记：卡片正中一枚红字「离线」，背后一层半透明遮挡把读数压下去——离线机器的
 * 数字停在掉线那一刻，不再假装实时 ★不沉底排序、不禁点：遮罩不接指针事件，点击
 * 落到卡片本体上，照样进详情页 「未接入」（从未上过报）不算离线，不挂这枚
 */
export function OfflineMark() {
  return (
    <span data-offline-mark="" aria-hidden className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-lg">
      <span className="absolute inset-0 rounded-lg bg-card/60" />
      <span className="relative text-sm font-semibold text-red-500">离线</span>
    </span>
  )
}

// 上游的「圆点 + 在线时长」徽章与详细档标题行的状态点都已随本主题删除：在线与否
// 已写成文字（见 onlineText / NodeDetail 的 onlineFor），不必再用圆点重复

/**
 * Where the machine is: its flag, or the bare code for one the set lacks.
 * 旗子是主题自带的静态文件（`/flags/<CC>.svg`），按国家码现取一张；取不到就退回
 * 文字徽标（非 ISO 码、文件缺失都走这一条），不留一枚破图
 */
export function Country({ node }: { node: Node }) {
  const [missing, setMissing] = useState(false)
  const code = (node.country || "").trim().toUpperCase()
  if (!code) return null
  if (missing) {
    return (
      <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
        {code}
      </Badge>
    )
  }
  return (
    <img
      src={`/flags/${code}.svg`}
      alt={code}
      title={code}
      width={24}
      height={18}
      loading="lazy"
      // 24×18（4:3）：比一行 12px 的字高一档才看得清，1px 描边让白底旗仍有边界
      // `object-cover` 裁掉画布上下留白，`-translate-y-px` 抵消行盒与基线的 1px 落差
      className="h-[18px] w-6 shrink-0 -translate-y-px rounded-[3px] object-cover ring-1 ring-border/70"
      onError={() => setMissing(true)}
    />
  )
}

/* ------------------------------------------------------------------ 详细档的小件 */

/** 详细档第二行左边那句「在线 …」 没接入的节点没有时长可说，返回 null */
function onlineText(node: Node): string | null {
  if (node.online) return node.metrics ? `在线 ${uptime(node.metrics.uptime)}` : "在线"
  if (!deployed(node)) return null
  const down = offlineSeconds(node)
  return down !== null && down >= 60 ? `离线 ${uptime(down)}` : "离线"
}

function priceText(node: Node): string | null {
  return node.price > 0 ? money(node.price, node.currency) : null
}

function cycleText(node: Node): string | null {
  if (node.price <= 0) return null
  return CYCLES[node.billing_cycle] ?? (node.billing_cycle || null)
}

/**
 * 到期还剩多少天 优先用 hub 算好的 `expires_in`：它按 hub 的时区算，还会给在线节点
 * 顺延到期日，访客自己按浏览器时钟算会在顺延前的那几个小时里显示成「已过期」只有
 * 旧 hub 没这个 key 时，才退回按 `expires_at` 自己数
 */
function expiryText(node: Node): string | null {
  const days = node.expires_in !== undefined ? node.expires_in : daysUntil(node.expires_at)
  if (days === null || days === undefined) return null
  if (days < 0) return `已过期 ${-days} 天`
  if (days === 0) return "今天到期"
  return `剩余 ${days} 天`
}

/** 详细档第二行：左「在线时长」、右「价格 / 周期」 */
function MetaRow({ node }: { node: Node }) {
  const online = onlineText(node)
  const price = priceText(node)
  const cycle = cycleText(node)
  if (!online && !price) return null
  return (
    <div data-meta="" className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span className="truncate">{online}</span>
      {price && <span className="tnum shrink-0">{cycle ? `${price} / ${cycle}` : price}</span>}
    </div>
  )
}

/** 详细档那三枚读数盒：实时速率 / 累计总量 / 剩余时间 一层浅底把它们与上下的网格分开 */
function InfoBox({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5 overflow-hidden rounded-md bg-muted/60 px-2 py-2 text-xs">
      {children}
    </div>
  )
}

function Stat({ icon: Icon, children }: {
  icon: ComponentType<{ className?: string }>
  children: ReactNode
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className="size-3 shrink-0" />
      <span className="tnum truncate">{children}</span>
    </span>
  )
}

// Traffic uses the plan's own counting rule, so the bar matches the quota the
// node is billed against.
function trafficFoot(node: Node) {
  return node.traffic_limit > 0
    ? pair(monthUsage(node), node.traffic_limit)
    : `${bytes(monthUsage(node))} / ${FOREVER}`
}

/**
 * 备注小卡片：**私有那几枚带锁 + 描边**（仅自己可见），公有那几枚实心 `secondary`
 * 卡片（详细档标题行、经典/延迟的浮层）与整页详情、紧凑展开行共用这一套——写法只有一处，
 * 合并后的次序（私有在前、公有在后）也由 `@/lib/notes` 的 `remarkChips` 一处决定
 */
export function RemarkChips({ chips, max = "full", keep = false, compact = false }: { chips: RemarkChip[]; max?: string; keep?: boolean; compact?: boolean }) {
  return (
    <>
      {chips.map((c, i) => (
        <Badge
          key={i + "-" + c.text}
          variant={c.own ? "outline" : "secondary"}
          // keep（详细档标题行那一格）：小卡片保持自然宽度、不许被挤扁；
          // 放不下的部分由外层裁掉、在悬浮层里看全
          className={(keep ? "shrink-0 " : "min-w-0 shrink ") + "font-normal " + (c.own ? "gap-1 text-muted-foreground " : "") + (compact ? "px-1.5 py-0 text-[11px] leading-[14px]" : "")}
          style={{ maxWidth: max === "full" ? undefined : max }}
          title={c.own ? "仅自己可见：" + c.text : c.text}
        >
          {c.own && <Lock className="size-3 shrink-0" aria-hidden />}
          <span className="min-w-0 truncate">{c.text}</span>
        </Badge>
      ))}
    </>
  )
}

export function NodeCard({ node, onOpen, onWarm, latencyLines, cardStyle, remarkPlacement, terms, selected }: {
  node: Node
  onOpen: () => void
  /** 指针或键盘刚落到这张卡片上：先把手头这块 chunk（详情页的图表那 391KB）取回来 */
  onWarm?: () => void
  latencyLines: string
  cardStyle: "classic" | "latency" | "detailed" | "detailedNoLatency" | "plain" | "wide"
  /** 「备注显示位置」：`detail` 时卡片这一侧一枚都不摊（整页详情照旧，见 NodeDetail） */
  remarkPlacement?: RemarkPlacement
  /** 搜索命中词：名字里命中的片段描色（见 TextHighlight）；没在搜时是空数组 */
  terms?: string[]
  /** 搜索键盘光标（↑↓）停在这张卡上：加一圈描边 */
  selected?: boolean
}) {
  const m = node.metrics
  // 详细档（含「详细·无延迟」）：图标、元信息行与三枚读数盒都只在它里面出现；配色仍与另外两档同一套灰
  const detailed = cardStyle === "detailed" || cardStyle === "detailedNoLatency"
  // 经典档：底部是 2×2 四格、不含延迟；备注与「延迟」档一样收在右上角那枚浮层里（见 peek）
  // 简约档：结构、内容、位置与经典档完全一致，只换一套视觉处理——标签改用前景色、
  // 进度条压到 4px、底注降到 11px、名字加粗一档、格子间距收紧（见下方各处 plain 分支）
  // ★ 按站长的口径，简约档**不显示公开备注**（其余四档都显示），这一档保持原样
  const plain = cardStyle === "plain"
  // 这台机器的备注（见 @/lib/notes）：私有在前（仅自己可见）、公有在后，都拆成一枚枚小卡片
  // 备注那一串：先按「备注显示位置」判这一侧要不要摊，再交给 @/lib/notes 拆（私有在前、公有在后）
  const chips = remarksOnCards(remarkPlacement ?? "both") ? remarkChips(node) : []
  /**
   * 「经典」「延迟」两档右上角那枚信息控件：悬停或点击弹出浮层（备注 + 在线时间 +
   * 价格 + 到期） 这两档常驻这枚控件：没写备注的机器点开也能看到那几项——
   * 不然它们在这两档上根本无处可看
   */
  const peek = cardStyle === "classic" || cardStyle === "latency"
  const [peekOpen, setPeekOpen] = useState(false)
  const peekRef = useRef<HTMLSpanElement>(null)
  // 「详细」档标题行那一格：悬停弹悬浮层，把放不下的备注看全（只有这一档有，另两档收在 ⓘ 里）
  const [titlePeek, setTitlePeek] = useState(false)
  const titlePeekRef = useRef<HTMLSpanElement>(null)
  // 钉住（点开）之后点别处要能收起；点卡片别的地方会跳详情页，所以只在浮层外按下时收
  useEffect(() => {
    if (!peekOpen) return
    const onDown = (e: PointerEvent) => {
      // 别写 `e.target as Node`：本文件里的 `Node` 是主题自己的节点类型（@/lib/api），
      // 会和 DOM 的 Node 撞名 globalThis.Node 也包含 SVG 与 path 等图标节点
      const el = e.target
      if (!(el instanceof globalThis.Node) || !peekRef.current?.contains(el)) setPeekOpen(false)
    }
    document.addEventListener("pointerdown", onDown)
    return () => document.removeEventListener("pointerdown", onDown)
  }, [peekOpen])
  // 宽卡是第六档独立版式（见 WideCard），这里直接委托过去，不挤进下面的分支
  // ★必须放在所有 hooks 之后：访客在顶栏换卡片形态时同一个组件实例会以不同档位重渲染，
  //   提前 return 会让 hooks 的调用顺序在两次渲染之间错位（rules-of-hooks）
  if (cardStyle === "wide") return <WideCard node={node} onOpen={onOpen} onWarm={onWarm} remarkPlacement={remarkPlacement} terms={terms} selected={selected} />
  const price = priceText(node)
  const cycle = cycleText(node)
  // 已部署但掉线：挂离线标记（未接入的不算，见 OfflineMark）
  const offline = !node.online && deployed(node)

  // 卡片底部那一行网络：经典、简约、延迟三档共用**同一个节点**——一行两段，
  // 左边实时速率（前景色）、右边累计总量（弱化灰）；箭头用文字 ↓ ↑，整段可原样复制
  const netRow = (
    <div data-net="row" className="tnum mt-3 flex items-center justify-between gap-2 border-t pt-2.5 text-xs">
      <span className="truncate">{m ? `↓ ${rate(m.net_rx)} ↑ ${rate(m.net_tx)}` : "—"}</span>
      <span className="truncate text-muted-foreground">
        {`↓ ${bytes(node.total_rx)} ↑ ${bytes(node.total_tx)}`}
      </span>
    </div>
  )

  // 经典档底部＝2×2 四格：速率一行、总量一行；箭头是文字 ↓ ↑，第一行数值前景色、其余弱化
  const netGrid = (
    <div data-net="grid" className="tnum mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-4 text-xs">
      <span>
        <span className="text-muted-foreground">↓</span> {m ? rate(m.net_rx) : "—"}
      </span>
      <span>
        <span className="text-muted-foreground">↑</span> {m ? rate(m.net_tx) : "—"}
      </span>
      <span className="text-muted-foreground">↓ {bytes(node.total_rx)}</span>
      <span className="text-muted-foreground">↑ {bytes(node.total_tx)}</span>
    </div>
  )

  return (
    <Card
      onClick={onOpen}
      // 摸到卡片（悬停 / 键盘 Tab 到它 / 手指按下）就先取详情那块 chunk：真要打开的人，
      // 鼠标按下去之前多半已经碰过这张卡了 见 App 的 warmDetail
      onPointerOver={onWarm}
      onFocus={onWarm}
      onTouchStart={onWarm}
      // data-node-card 是搜索键盘光标滚进视野的锚点（NodeList 的 scrollIntoView）；
      // data-selected 是「当前被键盘选中」的标记（护栏读它，不用去解析类名）
      data-node-card={node.id}
      data-selected={selected ? "1" : undefined}
      // min-w-0: a grid item sizes to its content unless told otherwise, and the
      // name line below does not wrap, so on a phone the card would grow past its
      // column and scroll the page sideways. The truncate inside only takes effect
      // once the card is allowed to be narrower.
      className={`min-w-0 cursor-pointer gap-0 p-4 transition-colors hover:border-foreground/25${offline ? " relative" : ""}${selected ? " outline-2 outline-offset-1 outline-ring" : ""}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
    >
      {/* 一行身份：旗子在前、名字在后 列表页一眼要看的是哪台机器；
          系统与到期在详情页写得更全，挤在卡片上只会把名字推到省略号 */}
      <div className="flex min-w-0 items-center gap-2">
        <Country node={node} />
        {/* 简约档只把名字加粗一档，文字与位置照旧；搜索命中的片段在这层里描色 */}
        <h3 className={`min-w-0 truncate ${plain ? "font-semibold" : "font-medium"}`}><TextHighlight text={node.name} terms={terms} /></h3>
        {/* 「详细」档的备注：挂在标题行右端 ★名字优先：备注这格 `grow basis-0`——
            基准尺寸是 0，从不参与「谁先被压」的竞争，不够就自己截断（宁可备注隐身，
            也不动机器名） 「经典」档收进右上角浮层，「简约」档不挂，
            「紧凑」档收在展开行量程栏那格（见 NodeDetail） */}
        {detailed && chips.length > 0 && (
          /* 备注只占一行，放不下的裁在边缘外，悬停弹悬浮层看全
             ★悬浮层必须挂在这个没有 overflow-hidden 的外层上，内层才是会裁的那一行 */
          <span
            ref={titlePeekRef}
            className="relative ml-auto flex min-w-0 max-w-[40%] grow basis-0 items-center justify-end sm:max-w-[55%]"
            onPointerEnter={() => setTitlePeek(true)}
            onPointerLeave={() => setTitlePeek(false)}
          >
            {/* ★`justify-start`（不是 end）：右对齐时溢出往左跑，被裁的会是排最前的
                私有那枚；左对齐则裁尾巴，前几枚完整 */}
            <span data-remark="title" className="flex min-w-0 items-center justify-start gap-1 overflow-hidden">
              <RemarkChips chips={chips} max="9rem" keep />
            </span>
            {titlePeek && (
              <span
                data-remark-panel
                className="absolute right-0 top-5 z-20 flex w-max max-w-[18rem] flex-wrap justify-end gap-1 rounded-md border bg-popover px-2 py-1.5 shadow-md"
              >
                <RemarkChips chips={chips} />
              </span>
            )}
          </span>
        )}
        {/* 「经典」「延迟」两档右上角的信息控件（悬停/点击弹浮层：备注 · 在线时间 · 价格 · 到期，
            经典档最下面还有三网延迟）卡片自己是 role=button，点击与 Enter/空格都要拦在
            控件里别冒泡成「打开详情页」 */}
        {peek && (
          // 触摸只走 click 开合，避免 touchEnd 的 pointerleave 先关、随后 click 又打开
          <span
            ref={peekRef}
            className="relative ml-auto shrink-0"
            onPointerEnter={(e) => { if (e.pointerType === "mouse") setPeekOpen(true) }}
            onPointerLeave={(e) => { if (e.pointerType === "mouse") setPeekOpen(false) }}
          >
            <button
              type="button"
              data-note-popover=""
              aria-expanded={peekOpen}
              aria-label="备注、在线时间、价格、到期与三网延迟"
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setPeekOpen(false) }}
              onClick={(e) => { e.stopPropagation(); setPeekOpen((v) => !v) }}
              className="grid size-5 place-items-center rounded-full text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Info className="size-3.5" />
            </button>
            {peekOpen && (
              <span
                data-note-panel=""
                // 「经典」档最下面多一块三网延迟，要宽一点才装得下
                className={`absolute right-0 top-6 z-20 block ${cardStyle === "classic" ? "w-72" : "w-56"} space-y-1.5 rounded-md border bg-popover px-3 py-2.5 text-xs shadow-md`}
              >
                {/* 公开备注：一枚一枚小卡片（逗号或分号分隔的多枚也就排成多枚），
                    没有备注的机器不占这一行 浮层是这一档唯一能读到它的地方（卡片上不占位） */}
                {chips.length > 0 && (
                  <span data-note-remark="" className="flex min-w-0 flex-wrap items-center gap-1">
                    <RemarkChips chips={chips} />
                  </span>
                )}
                <span className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">在线时间</span>
                  <span className="tnum min-w-0 truncate">{onlineText(node) ?? "—"}</span>
                </span>
                {price && (
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">价格</span>
                    <span className="tnum min-w-0 truncate">{cycle ? `${price} / ${cycle}` : price}</span>
                  </span>
                )}
                <span className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">到期</span>
                  <span className="tnum min-w-0 truncate">{expiryText(node) ?? "无期限"}</span>
                </span>
                {/* 三网延迟排在计费那几行下面、自带一条分隔线；只有「经典」档挂它，且要打开浮层才取数 */}
                {cardStyle === "classic" && <PeekLatency node={node} lines={latencyLines} />}
              </span>
            )}
          </span>
        )}
      </div>

      {/* One layout for both states: a disconnected node still knows its
          cores, memory, disk size and traffic totals, and showing those with
          the live figures blank beats a stretched card with one line in it. */}
      {deployed(node) ? (
        <>
          {detailed && <MetaRow node={node} />}

          <div className={`mt-4 grid grid-cols-2 gap-x-4 ${plain ? "gap-y-3" : "gap-y-4"}`}>
            {/* The core count belongs beside the word CPU: it is what the
                percentage and the load averages are both measured against. */}
            <Meter
              plain={plain}
              icon={detailed ? Cpu : undefined}
              label={plain
                ? <>CPU <span className="text-muted-foreground">{node.cpu_cores} 核</span></>
                : `CPU ${node.cpu_cores} 核`}
              pct={m ? m.cpu : null}
              foot={m ? m.load.map((n) => n.toFixed(2)).join(" ") : "—"}
            />
            <Meter
              plain={plain}
              icon={detailed ? MemoryStick : undefined}
              label="内存"
              pct={m ? percent(m.mem_used, m.mem_total) : null}
              foot={m ? pair(m.mem_used, m.mem_total) : bytes(node.mem_total)}
            />
            <Meter
              plain={plain}
              icon={detailed ? HardDrive : undefined}
              label="硬盘"
              pct={m ? percent(m.disk_used, m.disk_total) : null}
              foot={m ? pair(m.disk_used, m.disk_total) : bytes(node.disk_total)}
            />
            <Meter
              plain={plain}
              icon={detailed ? ArrowDownUp : undefined}
              label="流量"
              pct={node.traffic_limit > 0 ? percent(monthUsage(node), node.traffic_limit) : null}
              empty={FOREVER}
              foot={trafficFoot(node)}
            />
          </div>

          {cardStyle === "classic" ? (
            netGrid
          ) : cardStyle === "plain" ? (
            netRow
          ) : cardStyle === "latency" ? (
            <>
              {/* 延迟档底部与「简约」同一行版式（就是上面那同一个 netRow 节点），
                  分隔线由它自己的 border-t 画在上面，三网延迟再从下面那条线开始 */}
              {netRow}
              {/* 三网延迟：每条线路一行，数据来自 hub 的 ping 历史（详见 Latency.tsx） */}
              <LatencyPanel node={node} lines={latencyLines} />
            </>
          ) : (
            <>
              {/* 详细形态：三枚读数盒并排，第三枚上面是「剩余时间」、下面写到期日
                  「详细」挂三网延迟，「详细·无延迟」不挂 */}
              <div className="mt-4 grid grid-cols-3 gap-2">
                <InfoBox>
                  <Stat icon={ArrowDown}>{m ? rate(m.net_rx) : "—"}</Stat>
                  <Stat icon={ArrowUp}>{m ? rate(m.net_tx) : "—"}</Stat>
                </InfoBox>
                <InfoBox>
                  <Stat icon={ArrowDown}>{bytes(node.total_rx)}</Stat>
                  <Stat icon={ArrowUp}>{bytes(node.total_tx)}</Stat>
                </InfoBox>
                <InfoBox>
                  <Stat icon={CalendarClock}>{expiryText(node) ?? "无期限"}</Stat>
                  {node.expires_at && (
                    <span className="block truncate pl-[18px] text-muted-foreground">{node.expires_at}</span>
                  )}
                </InfoBox>
              </div>
              {cardStyle !== "detailedNoLatency" && <LatencyPanel node={node} lines={latencyLines} />}
            </>
          )}
        </>
      ) : (
        /* Never connected: nothing to plot, so the card stays short rather than
           padding out to match its neighbours. */
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          还没有接入在后台生成安装命令并执行一次
        </p>
      )}
      {offline && <OfflineMark />}
    </Card>
  )
}
