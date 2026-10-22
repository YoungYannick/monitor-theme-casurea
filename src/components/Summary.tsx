import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp } from "lucide-react"
import { Tooltip } from "radix-ui"

import { Card } from "@/components/ui/card"
import { InfoTooltip } from "@/components/InfoTooltip"
import type { Node } from "@/lib/api"
import { bytes, daysUntil, rate } from "@/lib/format"
import { budgetOf, cny, fxNote, parseRateOverrides, type BudgetItem } from "@/lib/money"
import { useExchangeRates } from "@/lib/use-exchange-rates"
import { summarize, type Fleet } from "@/lib/summary"
import { speedSeriesOf } from "@/lib/speed-history"

/**
 * 列表页顶上那行概览卡片，两副面孔（主题设置的「列表页顶部」里选）：
 *   原版（summary / both）——四张卡片各一块读数：节点 / 最忙节点 / 今日流量 / 实时网速
 *   月度预算剩余价值版（budget / bothBudget）——前两张各排两块读数（剩余总价值 + 月均总支出、
 *   节点 + 最忙节点），后两张两副面孔一样
 *
 * 第四张下面那条走势线画访客打开页面后自己攒下的实时速率（`speedHistory`，约 2 分钟）：
 * hub 没有「全站速率历史」接口，刷新就得重新攒，冷启动头几秒是空的
 * ★口径跟着筛选结果走：传进来的是当前分组、地区与搜索筛选出的节点，
 * 与下面那批卡片是同一批机器；收窄到一台不剩时「节点」卡写「没有匹配的节点」
 */

/**
 * 块上的悬停提示走公共组件（@/components/InfoTooltip）：预算块的口径说明、账单页
 * 名称列的机器信息卡都是它
 */

/**
 * 一块读数：一行小标签、一行大数字、一行小字`mt-auto` 把底部那行压到同排最高那块的
 * 下沿，内容行数不同也对齐
 *
 * 两种可交互形态（只给预算那两块用）：
 *   `onOpen` —— 点击进账单页（账单开着且访客有权时；口径与 App 的 billingVisible 同一份）
 *     能进账单页的人直接看全量账单，不再挂明细浮层，悬停提示也换成指路的那句
 *   `detail` —— 悬停 / 聚焦 / 触屏点按弹出逐台明细浮层（没有账单入口时的那副面孔）
 *     浮层里已带口径行（BudgetDetail 的 note），这时不再挂 InfoTooltip，免得两个浮层叠着弹
 */
function Block({ title, hint, detail, onOpen, children }: {
  title: string
  /** 悬停提示：口径说明——月均总支出与剩余总价值那两个数不是一眼能看懂的，得写清楚 */
  hint?: string
  /** 悬停 / 聚焦 / 触屏点按弹出的明细浮层（见 BudgetDetail） */
  detail?: ReactNode
  /** 点击进账单页；挂了它这块就是一枚按钮 */
  onOpen?: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const interactive = onOpen !== undefined || detail !== undefined
  // 开着的浮层：点别处 / Esc 收起（与 NodeCard 那枚浮层同一个做法）
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const el = e.target
      if (!(el instanceof HTMLElement) || !ref.current?.contains(el)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("pointerdown", onDown)
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey) }
  }, [open])
  return (
    <InfoTooltip text={onOpen ? "点击进入账单页，看逐台的月均与剩余价值明细" : detail ? undefined : hint}>
      <div
        ref={ref}
        className={`relative flex min-w-0 flex-col${interactive ? " cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" : ""}`}
        tabIndex={interactive ? 0 : undefined}
        role={interactive ? "button" : undefined}
        aria-expanded={detail ? open : undefined}
        onPointerEnter={detail ? (e) => { if (e.pointerType === "mouse") setOpen(true) } : undefined}
        onPointerLeave={detail ? (e) => { if (e.pointerType === "mouse") setOpen(false) } : undefined}
        onFocus={detail ? () => setOpen(true) : undefined}
        onBlur={detail ? () => setOpen(false) : undefined}
        onClick={onOpen ?? (detail ? () => setOpen(true) : undefined)}
        onKeyDown={onOpen ? (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onOpen()
          }
        } : undefined}
      >
        <div className="truncate text-xs text-muted-foreground">{title}</div>
        {children}
        {detail !== undefined && open && (
          // 浮层紧贴块底（不留 mt 空隙）：指针从块移进浮层的路上才不会触发 pointerleave 闪关；
          // 上限高 + 内部滚动写在 index.css 的 .budget-detail 里——近百行明细也在这一个
          // 浮层里滚着看，不会把浮层拖出屏幕
          <span data-budget-detail="" className="budget-detail absolute left-0 top-full z-20 block w-max max-w-[15rem] space-y-1 rounded-md border bg-popover px-2.5 py-2 text-xs shadow-md">
            {detail}
          </span>
        )}
      </div>
    </InfoTooltip>
  )
}

/** 预算卡两枚浮层的内容：逐台明细（金额降序，与 budgetOf 的明细同序）+ 口径行 */
function BudgetDetail({ head, items, note }: { head: string; items: BudgetItem[]; note: string }) {
  return (
    <>
      {/* 表头带上条数（「各节点月摊 · 87 台」）：浮层能滚了之后，第一眼就知道一共有多少台 */}
      <span className="block text-muted-foreground">{head} · {items.length} 台</span>
      {items.map((item, i) => (
        <span key={i} data-budget-row="" className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate">{item.name}</span>
          <span className="tnum shrink-0">≈{cny(item.amount)}</span>
        </span>
      ))}
      <span className="block border-t pt-1 text-muted-foreground">{note}</span>
    </>
  )
}

/**
 * 一块读数里的主数字 `tnum` 让数字等宽：每两秒刷一次时不会左右抖
 *
 * ★**长数字要缩号**：这一行是 `truncate`，窄列机位上装不下的长读数会被打成省略号
 * 做法：按当前断点的基准字号（手机 18px、`lg` 起 24px——量 computed style，不写死）量一次
 * 「文本宽 ÷ 格子宽」，装不下就按比例降字号（有下限，见 BIG_MIN），
 * 换断点 / 换列数 / 换字体 / 换长度各重量一次；`truncate` 留着当最后一道兜底
 * 降号只发生在真的装不下时，短读数（7 / 7）不受影响
 */
const BIG_MIN = 12
function Big({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      el.style.fontSize = ""                        // 先回到基准字号量，免得越缩越小
      el.style.lineHeight = ""
      const base = parseFloat(window.getComputedStyle(el).fontSize) || 24
      const baseH = el.getBoundingClientRect().height
      // scrollWidth/clientWidth 都会取整，亚像素溢出也会触发浏览器的省略号
      const cw = Math.max(0, el.getBoundingClientRect().width - 1)
      const text = document.createRange()
      text.selectNodeContents(el)
      const textWidth = () => text.getBoundingClientRect().width
      const sw = textWidth()
      if (cw > 0 && sw > cw) {
        // 行高钉在基准字号那一档：缩号只改字的大小，卡片高度零位移
        // （否则长读数那张卡会矮几像素，整行卡片跟着参差）
        el.style.lineHeight = `${baseH}px`
        let size = Math.max(BIG_MIN, Math.floor((base * cw) / sw))
        el.style.fontSize = `${size}px`
        // 数字旁的单位可能有独立字号，缩号后再次实测，而非假设整串同比例缩小
        while (size > BIG_MIN && textWidth() > cw) el.style.fontSize = `${--size}px`
      }
    }
    fit()
    const ro = new ResizeObserver(fit)              // 换列数 / 换长度都要重量
    ro.observe(el)
    // ★字体是**后到**的：先按兜底字体量会得出「装得下」，真字体一到就溢出
    //   所以加载完 + 头几帧各重量
    const timers = [0, 120, 400, 1200].map((ms) => window.setTimeout(fit, ms))
    const onDone = () => fit()
    if (typeof document !== "undefined" && document.fonts) {
      document.fonts.addEventListener?.("loadingdone", onDone)
      document.fonts.ready?.then(fit).catch(() => {})
      const cs = window.getComputedStyle(el)
      document.fonts.load?.(`${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`)?.then(fit)?.catch(() => {})
    }
    return () => {
      ro.disconnect()
      timers.forEach((t) => window.clearTimeout(t))
      document.fonts?.removeEventListener?.("loadingdone", onDone)
    }
  }, [children])
  return <div ref={ref} className="tnum mt-1 truncate text-lg font-semibold tracking-tight lg:text-2xl">{children}</div>
}

/** 一块读数底下那行小字（卡片两端对齐时它落在下沿） */
function Foot({ children }: { children: ReactNode }) {
  return <div className="tnum mt-auto truncate pt-1 text-xs text-muted-foreground">{children}</div>
}

/** 一张卡片：里面就一块读数（今日流量 / 实时网速，以及原版的每一张） */
function Tile({ children }: { children: ReactNode }) {
  return <Card className="min-w-0 gap-0 p-4">{children}</Card>
}

/**
 * 一张卡片里两块读数：`sm` 起**两块平分**（`grid-cols-2` + 同一个 `gap-x-2`），第二块
 * 与今日流量/实时网速两卡的右列同一落点——整行四张卡读起来是一个栅格
 * 手机上两块竖排（半宽卡里并排放不下长金额）下沿对齐靠 grid 默认的
 * `items-stretch` + Block 里的 `mt-auto`
 */
function Pair({ children }: { children: ReactNode }) {
  return (
    <Card className="grid min-w-0 grid-cols-1 gap-x-2 gap-y-2 p-4 sm:grid-cols-2 sm:gap-y-0">
      {children}
    </Card>
  )
}

/** 一枚带方向箭头的读数 颜色随所在那一行（今日是前景色，累计是弱化灰） */
function Val({ icon: Icon, children }: {
  icon: typeof ArrowDown
  children: ReactNode
}) {
  return (
    <span className="tnum inline-flex min-w-0 items-center gap-1">
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  )
}

/**
 * 读数里的「数字 / 单位」两段：数字保持所在断点的基准字号，单位降一档（常规字重、弱化灰）
 * 为的是宽度：这一行 `truncate`，四列布局下文字框只有 77~111px，24px 的「1023.9 KB/s」
 * 装不下会被静默截断，单位降一档能省 20px 只给上面那行大数用（底部小字本来就 12px）
 * 空格留在单位前——否则复制文本与读屏会把两个词黏成「112.6KB/s」
 */
function Unit({ children }: { children: string }) {
  const m = children.match(/^([0-9.,]+)\s*(.+)$/)
  if (!m) return <>{children}</>
  return (
    <>
      {m[1]}
      <span className="text-sm font-normal text-muted-foreground lg:text-base"> {m[2]}</span>
    </>
  )
}

// viewBox 的横纵与卡片实际尺寸无关：下面的 preserveAspectRatio 会把它拉满整行，
// 纵轴按自己的最大值缩放 零基准——网速这种量没有上限可参照，不零基准会把
// 「一直很忙」和「偶尔抖一下」画成同一个形状
const W = 100
const H = 28

/**
 * 实时网速下面那条走势线：下行 / 上行两条折线，无坐标轴、无填充 `preserveAspectRatio="none"`
 * 拉满卡片，每条线挂 `vectorEffect="non-scaling-stroke"` 把线宽钉回 1px采样点少于两个
 * 就只占位不画线；高度照留，卡片不会因此跳一下
 */
function Sparkline({ series }: { series: { rx: number; tx: number }[] }) {
  const ready = series.length > 1
  const max = Math.max(1, ...series.map((s) => Math.max(s.rx, s.tx)))
  const line = (pick: (s: { rx: number; tx: number }) => number) =>
    series
      .map((s, i) => `${((i / (series.length - 1)) * W).toFixed(2)},${(H - 1 - (pick(s) / max) * (H - 2)).toFixed(2)}`)
      .join(" ")
  return (
    /* 高度约 22px：高了整行四张卡就不再等高 */
    <div className="mt-1 h-5">
      {ready && (
        <svg className="h-full w-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {/* 下行用前景色、上行用弱化灰：与卡片网络区那两个方向的读法一致 */}
          <polyline points={line((s) => s.rx)} fill="none" strokeWidth={1} vectorEffect="non-scaling-stroke" className="stroke-foreground/70" />
          <polyline points={line((s) => s.tx)} fill="none" strokeWidth={1} vectorEffect="non-scaling-stroke" className="stroke-muted-foreground/60" />
        </svg>
      )}
    </div>
  )
}

/** 「节点」那块读数：在线 / 总数 + 离线台数 两副面孔共用，块本身一模一样 */
function NodesBlock({ fleet, searching = false }: { fleet: Fleet; searching?: boolean }) {
  const offline = fleet.total - fleet.online
  return (
    <Block title="节点">
      {/* 斜杠与总数降一档（常规字重 / 弱化灰），只有在线数是大数空格留着：
          抹掉它复制与读屏会得到「3/4」这种黏成一团的写法 */}
      <Big>
        {fleet.online} <span className="text-sm font-normal text-muted-foreground lg:text-base">/ {fleet.total}</span>
      </Big>
      <Foot>
        {/* 「一台都没有」有两种成因，说法得分开：站点本来就没有节点，还是搜索把当前那批全筛掉了 */}
        {fleet.total === 0 ? (searching ? "没有匹配的节点" : "还没有节点") : offline === 0 ? "全部在线" : `${offline} 台离线`}
      </Foot>
    </Block>
  )
}

/** 「最忙节点」那块读数：CPU 占用最高的在线节点 */
function BusiestBlock({ fleet }: { fleet: Fleet }) {
  return (
    <Block title="最忙节点">
      {/* 一位小数，与卡片里 CPU 那格同一个口径 */}
      <Big>{fleet.busiest ? `${fleet.busiest.cpu.toFixed(1)}%` : "—"}</Big>
      <Foot>
        {fleet.busiest ? fleet.busiest.name : "无在线节点"}
      </Foot>
    </Block>
  )
}

export function SummaryCards({ nodes, finance = false, searching = false, exchangeRates = "", excludeTag = "", onOpenBilling }: { nodes: Node[]; finance?: boolean; searching?: boolean; exchangeRates?: string; excludeTag?: string; onOpenBilling?: () => void }) {
  const fleet = summarize(nodes)
  const custom = useMemo(() => parseRateOverrides(exchangeRates), [exchangeRates])
  const needsFx = finance && nodes.some((node) => {
    const code = (node.currency || "").trim().toUpperCase()
    return Number.isFinite(node.price) && node.price > 0 && node.billing_cycle !== "once" && code !== "CNY" && !Object.hasOwn(custom.rates, code)
  })
  const fx = useExchangeRates(needsFx)
  const rates = useMemo(() => ({ ...fx.snapshot.rates, ...custom.rates, CNY: 1 }), [fx.snapshot.rates, custom.rates])
  const budget = budgetOf(nodes, rates, excludeTag)
  // 与上方读数使用相同节点集合：分组、地区、搜索三层筛选都作用于历史快照
  // 缓冲仍由 useNodes 维护，进详情再返回不会丢失已收集的历史
  const series = speedSeriesOf(nodes)
  // 折算说明：只列真的用到过的币种——各站的账混着 USD / EUR / CNY 记，合起来必须说明口径
  const note = fxNote(budget.used, budget.skipped, { rates, date: fx.snapshot.date, custom: custom.rates, label: "按参考汇率折算" })
  // 覆盖率始终写分数 N/M，分母是全部节点数：免费机器不计月账，但仍计入台数
  const monthlyCoverage = `${budget.monthlyCount}/${nodes.length}`
  // 「未到期」的分子：一次性买断与无到期日的机器属长期持有，也算未到期；分子只剔已过期的
  const notExpired = nodes.filter((n) => {
    const left = typeof n.expires_in === "number" ? n.expires_in : daysUntil(n.expires_at)
    return left === null || left >= 0
  }).length
  const remainingCoverage = `${notExpired}/${nodes.length}`
  const showFx = finance && (budget.used.some((code) => code !== "CNY") || budget.skipped.length > 0 || custom.invalid > 0)
  const stateLabel = fx.loading ? "正在更新"
    : fx.failed ? fx.origin === "empty" ? "获取失败，暂无汇率" : "获取失败，用缓存汇率"
    : fx.origin === "empty" ? "正在获取汇率" : fx.origin === "cache" ? "使用缓存" : "已自动更新"
  const oldQuote = Date.now() - Date.parse(`${fx.snapshot.date}T00:00:00Z`) >= 3 * 86_400_000
  const status = needsFx ? `每日参考汇率${fx.snapshot.date ? ` · ${fx.snapshot.date}` : ""} · ${stateLabel}${oldQuote ? "（旧汇率）" : ""}` : "自定义汇率"
  const received = fx.origin === "empty" ? "等待首次成功获取" : `获取于 ${new Date(fx.snapshot.fetchedAtMs).toLocaleString("zh-CN")}`
  // 两句口径说明：块的悬停提示（InfoTooltip）与明细浮层的尾行同一份，别让两处说岔
  const monthlyNote = `各节点的价格按计费周期摊到每个月后相加；一次性买断与没填价格的不计入${note}`
  const remainingNote = `已经付掉、还没用掉的那一段：价格 × 剩余天数 ÷ 周期天数；没填价格、无到期日与一次性买断的不计入${note}`

  return (
    <Tooltip.Provider delayDuration={300}>
      {/* 版式：手机起就两列、`lg` 起四列——一行两个省垂直空间（站长要求）；手机上卡片内部并排的
          读数改竖排、主数字降一档（Big 缩号与 `truncate` 仍兜底），不再把手机压成一列 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {finance ? (
        <>
          {/* 第一张卡：剩余总价值 + 月均总支出 两个数使用同一份汇率折成人民币后相加，
              所以写「≈」；口径与汇率清单放在悬停提示里（见 lib/money.ts）
              ★账单联动（onOpenBilling，App 传的 billingVisible 口径）：账单开着且访客有权，
              两块读数点下去直接进账单页（那边有全量明细与日历）；没有这个入口时降级成
              悬停浮层——逐台明细摊开（detail，各有可计的机器才挂） */}
          <Pair>
            <Block
              title="剩余总价值"
              hint={remainingNote}
              onOpen={onOpenBilling}
              detail={!onOpenBilling && budget.remainingItems.length > 0 ? <BudgetDetail head="各节点剩余价值" items={budget.remainingItems} note={remainingNote} /> : undefined}
            >
              <Big>{budget.remaining === null ? "—" : `≈${cny(budget.remaining)}`}</Big>
              <Foot>{notExpired > 0 ? `${remainingCoverage} 台未到期` : budget.skipped.length ? "缺少汇率" : "无预付到期"}</Foot>
            </Block>
            <Block
              title="月均总支出"
              hint={monthlyNote}
              onOpen={onOpenBilling}
              detail={!onOpenBilling && budget.monthlyItems.length > 0 ? <BudgetDetail head="各节点月摊" items={budget.monthlyItems} note={monthlyNote} /> : undefined}
            >
              <Big>{budget.monthly === null ? "—" : `≈${cny(budget.monthly)}`}</Big>
              <Foot>{budget.monthlyCount ? `${monthlyCoverage} 台计费` : budget.skipped.length ? "缺少汇率" : "未记录价格"}</Foot>
            </Block>
          </Pair>

          {/* 第二张卡：节点 + 最忙节点，与上面同一套排法——两块读数分居卡片两端 */}
          <Pair>
            <NodesBlock fleet={fleet} searching={searching} />
            <BusiestBlock fleet={fleet} />
          </Pair>
        </>
      ) : (
        <>
          <Tile>
            <NodesBlock fleet={fleet} searching={searching} />
          </Tile>

          <Tile>
            <BusiestBlock fleet={fleet} />
          </Tile>
        </>
      )}

      <Tile>
        <Block title="今日流量">
          {/* 大数一行（今日上下行），累计并成一行小字——参考站整张卡就是「小标签 / 大数 /
              一行小字」三段，这样四张卡等高、整行才是一个节奏 四个数一个没少
              栅格间距沿用 `gap-x-2`（与 Pair 同一个值）：整行四张卡的第二列因此落在同一条
              竖线上（护栏钉着） */}
          <div className="mt-1 grid grid-cols-1 gap-x-2 gap-y-0.5 text-lg font-semibold tracking-tight sm:grid-cols-2 lg:text-2xl">
            <Val icon={ArrowDown}><Unit>{bytes(fleet.dayRx)}</Unit></Val>
            <Val icon={ArrowUp}><Unit>{bytes(fleet.dayTx)}</Unit></Val>
          </div>
          <Foot>
            <span className="inline-flex items-center gap-1.5">
              总流量
              <Val icon={ArrowDown}>{bytes(fleet.totalRx)}</Val>
              <Val icon={ArrowUp}>{bytes(fleet.totalTx)}</Val>
            </span>
          </Foot>
        </Block>
      </Tile>

      <Tile>
        <Block title="实时网速">
          <div className="mt-1 grid grid-cols-1 gap-x-2 gap-y-0.5 text-lg font-semibold tracking-tight sm:grid-cols-2 lg:text-2xl">
            <Val icon={ArrowDown}><Unit>{rate(fleet.netRx)}</Unit></Val>
            <Val icon={ArrowUp}><Unit>{rate(fleet.netTx)}</Unit></Val>
          </div>
          <Sparkline series={series} />
        </Block>
      </Tile>
      {showFx && (
        <div className="col-span-full -mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
          role="status" aria-label="预算汇率状态" data-exchange-rate-status="" data-fx-origin={fx.origin}
          data-fx-failed={fx.failed ? "true" : "false"} data-fx-loading={fx.loading ? "true" : "false"}
          title={`${note} ${needsFx ? `${received}；汇率每日更新，仅供参考 ` : "使用站点设置中的自定义汇率"}`}>
          <span>{status}</span>
          {needsFx && <a href={fx.snapshot.source === "exchangerate-fun" ? "https://www.exchangerate.fun/" : "https://github.com/fawazahmed0/exchange-api"} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">汇率来源</a>}
          {budget.skipped.length > 0 && <span>{budget.skipped.length} 种币种缺少汇率，未计入</span>}
          {custom.invalid > 0 && <span>忽略 {custom.invalid} 项无效自定义汇率</span>}
        </div>
      )}
      </div>
    </Tooltip.Provider>
  )
}
