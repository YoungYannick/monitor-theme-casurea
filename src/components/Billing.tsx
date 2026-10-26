import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Tooltip } from "radix-ui"
import { ArrowDown, ArrowUpDown, ArrowUp, ChevronLeft, ChevronRight, Info } from "lucide-react"

import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { InfoTooltip } from "@/components/InfoTooltip"
import { Country, RemarkChips } from "@/components/NodeCard"
import type { Node } from "@/lib/api"
import { BILLING_CURRENCIES, billingRowOf, moneyOf, type BillingCurrency, type BillingRow, type BillingStatus } from "@/lib/billing"
import { CYCLES, bytes, cpuName, daysUntil, money, osName } from "@/lib/format"
import { cycleMonthsOf, isExcludedByTag, parseRateOverrides } from "@/lib/money"
import { regionOf } from "@/lib/globe"
import { remarkChips } from "@/lib/notes"
import { COUNTRY_NAMES } from "@/lib/world"
import { useExchangeRates } from "@/lib/use-exchange-rates"

/**
 * 账单页：一张表看全站机器的价格、到期、月均价与剩余价值，并带一枚到期日历
 *
 * 数据全部来自 `/api/nodes` 里本来就有的价格 / 币种 / 周期 / 到期日，不多发请求；
 * 汇率只在确有外币要折算时才订阅网络更新（与首页预算同一套，见 use-exchange-rates）
 * 展示币种是**访客自己**的偏好（localStorage），默认人民币；切换后所有金额一起变
 */

const CURRENCY_KEY = "casurea:billing_currency"

function readCurrency(): string {
  try {
    const saved = localStorage.getItem(CURRENCY_KEY)
    if (saved && BILLING_CURRENCIES.some((c) => c.code === saved)) return saved
  } catch {
    // 存储被禁：回落默认
  }
  return "CNY"
}

/** 周期中文名：认不出的老值原样写，别吞掉信息；hub 自定义的 `<n>m` 折成「N 个月」 */
function cycleLabel(cycle: string): string {
  if (CYCLES[cycle]) return CYCLES[cycle]
  const m = /^(\d+)m$/.exec(cycle)
  return m ? `${Number(m[1])} 个月` : cycle
}

function statCard(title: string, value: string | null, hint?: string) {
  return (
    <Card className="min-w-0 gap-0 p-4" title={hint}>
      <div className="truncate text-xs text-muted-foreground">{title}</div>
      <div className="tnum mt-1 truncate text-lg font-semibold tracking-tight">{value ?? "—"}</div>
    </Card>
  )
}

/** 表格可排序的七列 */
type SortKey = "name" | "status" | "price" | "cycle" | "expires" | "monthly" | "remaining"
type Sort = { key: SortKey; dir: "asc" | "desc" }

/** 状态列的排序权重：越紧急越靠前（升序时已到期在最上）；null = 恢复默认权重序 */
const STATUS_ORDER: Record<BillingStatus, number> = { expired: 0, expiring: 1, active: 2, noexpiry: 3 }

const cycleMonths = (r: BillingRow) => {
  const m = cycleMonthsOf(r.node.billing_cycle)
  return Number.isFinite(m) ? m : 0
}

/** 各列比较器：金额缺汇率/免费当 0；到期按剩余天数升序（无到期日排最后） */
const SORTERS: Record<SortKey, (a: BillingRow, b: BillingRow) => number> = {
  name: (a, b) => a.node.name.localeCompare(b.node.name, "zh-CN"),
  status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  price: (a, b) => (a.price ?? 0) - (b.price ?? 0),
  cycle: (a, b) => cycleMonths(a) - cycleMonths(b),
  expires: (a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity),
  monthly: (a, b) => (a.monthly ?? 0) - (b.monthly ?? 0),
  remaining: (a, b) => (a.remaining ?? 0) - (b.remaining ?? 0),
}

/** 可排序的表头：点击循环「默认（节点权重序）→ 升序 → 降序 → 默认」，图标指方向 */
function SortTh({ label, k, sort, onPick, align }: { label: string; k: SortKey; sort: Sort | null; onPick: (s: Sort | null) => void; align: "left" | "right" }) {
  const active = sort?.key === k
  const Icon = active ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <th
      className={`px-3 py-2 font-normal ${align === "right" ? "text-right" : "text-left"}`}
      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        onClick={() => onPick(active && sort!.dir === "asc" ? { key: k, dir: "desc" } : active ? null : { key: k, dir: "asc" })}
        className={`inline-flex cursor-pointer items-center gap-1 whitespace-nowrap transition-colors hover:text-foreground ${align === "right" ? "flex-row-reverse" : ""}`}
        title={active && sort!.dir === "desc" ? "恢复默认排序" : active ? "改为降序" : "按此列排序"}
      >
        {label}
        <Icon className={`size-3 ${active ? "" : "opacity-30"}`} />
      </button>
    </th>
  )
}

/**
 * 名称列的悬浮卡：这台机器的完整档案——规格行「标签在前、值在后」同一套 dl 排版；
 * 地区行带旗子与国名（旗子复用卡片的 Country 组件）；备注拆成小卡片（与详情页同一套
 * RemarkChips：私有带锁描边、公有实心），不是一串原文
 * 私有备注匿名时 key 根本不存在（hub 不下发），自动不显示，不会占位
 */
function nodeInfo(node: Node): ReactNode {
  const region = regionOf(node)
  const specs: [string, ReactNode][] = []
  if (region) {
    // 旗子 + 国名（· 城市）；城名与国名相同（或没有城名）时只写一个
    const country = COUNTRY_NAMES[region.code] ?? region.code
    const city = region.city && region.city !== country ? ` · ${region.city}` : ""
    specs.push(["地区", <span key="region" className="inline-flex min-w-0 items-center gap-1.5"><Country node={node} /><span className="truncate">{country}{city}</span></span>])
  }
  if (node.os) specs.push(["系统", node.virt && node.virt !== "physical" ? `${osName(node.os)} · ${node.virt}` : osName(node.os)])
  if (node.kernel || node.arch) specs.push(["内核", [node.kernel, node.arch].filter(Boolean).join(" ")])
  if (node.cpu_cores > 0 || node.cpu_name) specs.push(["CPU", [node.cpu_name ? cpuName(node.cpu_name) : "", node.cpu_cores > 0 ? `${node.cpu_cores} 核` : ""].filter(Boolean).join(" · ")])
  if (node.mem_total > 0) specs.push(["内存", bytes(node.mem_total)])
  if (node.disk_total > 0) specs.push(["磁盘", bytes(node.disk_total)])
  const chips = remarkChips(node)
  return (
    <div className="min-w-[12rem] space-y-1.5">
      <div className="font-medium">{node.name}</div>
      {specs.length > 0 && (
        <dl className="space-y-0.5">
          {specs.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[3.5em_1fr] gap-x-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {chips.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-1 border-t pt-1.5">
          <RemarkChips chips={chips} compact />
        </div>
      )}
    </div>
  )
}

/** 一行的状态徽章与到期文案——纯到期维度（免费在价格列、一次性在周期列各自表达）；
 * 「即将到期」橙字配「N 天后」，与「已到期」红字配「N 天前」对称 */
function statusCell(row: BillingRow) {
  switch (row.status) {
    case "expired":
      return (
        <>
          <Badge variant="destructive" className="font-normal">已到期</Badge>
          <span className="text-xs text-muted-foreground">{row.daysLeft !== null ? `${-row.daysLeft} 天前` : ""}</span>
        </>
      )
    case "expiring":
      return row.daysLeft === 0
        ? <Badge variant="secondary" className="font-normal">今天到期</Badge>
        : (
          <>
            <Badge variant="outline" className="border-orange-500/40 font-normal text-orange-600 dark:text-orange-400">即将到期</Badge>
            <span className="text-xs text-muted-foreground">{row.daysLeft} 天后</span>
          </>
        )
    case "active":
      return <Badge variant="secondary" className="font-normal">未到期</Badge>
    case "noexpiry":
      return <Badge variant="secondary" className="font-normal">无期限</Badge>
  }
}

/** 年月选择 */
function MonthField({ ym, onChange }: { ym: { y: number; m: number }; onChange: (v: { y: number; m: number }) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const text = `${ym.y}-${String(ym.m + 1).padStart(2, "0")}`
  useEffect(() => {
    if (ref.current && ref.current.value !== text) ref.current.value = text
  }, [text])
  return (
    <input
      ref={ref}
      type="month"
      defaultValue={text}
      onChange={(e) => {
        const [y, m] = e.target.value.split("-").map(Number)
        if (Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12) onChange({ y, m: m - 1 })
      }}
      aria-label="选择年月"
      className="rounded-md border bg-background px-2 py-1 text-sm font-medium text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
    />
  )
}

/**
 * 到期日历：左边月历（角标当天到期台数、背景色阶、悬浮看清单、点击筛选当天），右边「即将到期」分段清单
 * （7 / 15 / 30 天三档互斥，档内卡片弹性拉伸、空档不显示）
 * 选中日子由父组件持有（pick）：日历高亮描边，账单表据此筛选；分段清单与悬浮面板点击某台机器
 * 也是走 pick——跳到它到期的月份、选中那一天，形成「清单/悬浮 → 日历 → 表格」一条联动链
 */
function BillingCalendar({
  nodes,
  rows,
  currencyCode,
  picked,
  onPick,
}: {
  nodes: Node[]
  rows: ReturnType<typeof billingRowOf>[]
  currencyCode: string
  picked: string | null
  onPick: (day: string | null) => void
}) {
  const today = new Date()
  // 用户手动翻到的月份（浏览位）；选中日 picked 存在时显示派生月，清除后回到浏览位——
  // 不用 effect 对齐，渲染期直接派生（表格「到期时间」列点击后日历跟着翻页就是这么来的）
  const [browsed, setBrowsed] = useState({ y: today.getFullYear(), m: today.getMonth() })
  const pickedYm = useMemo(() => {
    if (!picked) return null
    const [y, m] = picked.split("-").map(Number)
    return Number.isInteger(y) && Number.isInteger(m) ? { y, m: m - 1 } : null
  }, [picked])
  const ym = pickedYm ?? browsed

  // 30 天内到期（含今天），按剩余天数升序；天数口径与表格状态列同一套 daysUntil
  const upcoming = useMemo(() => {
    return nodes
      .map((n) => ({ n, days: daysUntil(n.expires_at) }))
      .filter((x): x is { n: Node; days: number } => x.days !== null && x.days >= 0 && x.days <= 30)
      .sort((a, b) => a.days - b.days)
  }, [nodes])

  // 拆三档互斥分段（≤7 / 8–15 / 16–30）：紧迫的分出来，长清单也短了；空档整块不显示
  const bands = useMemo(() => {
    const b: { label: string; items: { n: Node; days: number }[] }[] = [
      { label: "7 天内到期", items: [] },
      { label: "15 天内到期", items: [] },
      { label: "30 天内到期", items: [] },
    ]
    for (const x of upcoming) b[x.days <= 7 ? 0 : x.days <= 15 ? 1 : 2].items.push(x)
    return b
  }, [upcoming])

  // 即将到期合计金额（目标币种），免费机器不计
  const upcomingSum = useMemo(() => {
    const byId = new Map(rows.map((r) => [r.node.id, r]))
    return upcoming.reduce((sum, { n }) => sum + (byId.get(n.id)?.monthly ?? 0), 0)
  }, [rows, upcoming])
  const rowById = useMemo(() => new Map(rows.map((r) => [r.node.id, r])), [rows])

  // 有到期日的节点按「YYYY-MM-DD」归组；没到期日（长期可用）不进日历
  const byDay = useMemo(() => {
    const map = new Map<string, Node[]>()
    for (const n of nodes) {
      if (!n.expires_at) continue
      const day = n.expires_at.slice(0, 10)
      const arr = map.get(day) ?? []
      arr.push(n)
      map.set(day, arr)
    }
    return map
  }, [nodes])
  // 色阶上限：当天到期台数越多背景越深，最多的那天封顶
  const maxDue = Math.max(1, ...[...byDay.values()].map((list) => list.length))

  const first = new Date(ym.y, ym.m, 1)
  const daysInMonth = new Date(ym.y, ym.m + 1, 0).getDate()
  const offset = (first.getDay() + 6) % 7 // 周一排头
  // 翻页 / 回本月 / 年月选择：改的是浏览位；选中日还挂着时一并清掉——
  // 不然 ym 被 pickedYm 压着，用户翻了页页面却不动
  const browse = (v: { y: number; m: number }) => {
    setBrowsed(v)
    if (picked !== null) onPick(null)
  }
  const move = (delta: number) => {
    const d = new Date(ym.y, ym.m + delta, 1)
    browse({ y: d.getFullYear(), m: d.getMonth() })
  }
  const dayKey = (d: number) => `${ym.y}-${String(ym.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`

  // 选中某台机器：选中它到期的那一天（表格随之筛选；日历月份由 pickedYm 派生自动跟过去）；
  // 已选中时再点一次取消，与表格「到期时间」列同一个 toggle 手感
  const focusNode = (n: Node) => {
    if (!n.expires_at) return
    const [y, m, d] = n.expires_at.slice(0, 10).split("-").map(Number)
    const key = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
    onPick(picked === key ? null : key)
  }

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="mx-auto w-full max-w-[19rem] shrink-0 sm:mx-0">
          <div className="mb-2 flex items-center justify-between gap-2">
            <MonthField ym={ym} onChange={browse} />
            <div className="flex items-center gap-1">
              <button className="tap tap-6 rounded-md text-muted-foreground transition-colors hover:text-foreground" onClick={() => move(-1)} aria-label="上月" title="上月">
                <ChevronLeft className="size-4" />
              </button>
              <button
                className="tap tap-6 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => browse({ y: today.getFullYear(), m: today.getMonth() })}
                title="回本月"
              >
                本月
              </button>
              <button className="tap tap-6 rounded-md text-muted-foreground transition-colors hover:text-foreground" onClick={() => move(1)} aria-label="下月" title="下月">
                <ChevronRight className="size-4" />
              </button>
            </div>
          </div>

          {/* 恒定 42 格（6 行）：月份再短也不跳高度，越界的格子空占位 */}
          <Tooltip.Provider delayDuration={120}>
            <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
              {["一", "二", "三", "四", "五", "六", "日"].map((w) => <div key={w} className="py-0.5">{w}</div>)}
              {Array.from({ length: 42 }, (_, i) => {
                const d = i - offset + 1
                if (d < 1 || d > daysInMonth) return <div key={i} className="aspect-square" />
                const key = dayKey(d)
                const due = byDay.get(key)
                // 色阶：到期台数越多背景越浓，选中日用主色描边；背景走「前景色的实色阶」
                const heat = due ? Math.min(0.25 + (due.length / maxDue) * 0.75, 1) : 0
                const cell = (
                  <div
                    onClick={due ? () => onPick(picked === key ? null : key) : undefined}
                    className={`relative flex aspect-square items-center justify-center rounded-md text-sm transition-colors ${
                      due ? "cursor-pointer" : ""
                    } ${due ? "font-medium text-foreground" : ""} ${key < todayKey ? "text-muted-foreground/50" : ""} ${
                      key === todayKey ? "ring-1 ring-inset ring-foreground/60" : ""
                    } ${picked === key ? "ring-1 ring-primary/60" : ""}`}
                    style={due && heat ? { background: `color-mix(in oklab, var(--foreground) ${Math.round(heat * 40)}%, transparent)` } : undefined}
                  >
                    {d}
                    {due && <span aria-hidden className="tnum absolute right-0.5 top-0.5 text-[10px] font-medium leading-none text-destructive">{due.length}</span>}
                  </div>
                )
                if (!due) return <div key={key}>{cell}</div>
                return (
                  <Tooltip.Root key={key}>
                    <Tooltip.Trigger asChild>{cell}</Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content sideOffset={4} collisionPadding={8} className="z-20 max-w-[70vw] rounded-lg border bg-popover px-2 py-1.5 text-[11px] leading-tight shadow-md">
                        <div className="mb-1 text-muted-foreground">{key.slice(5)} 到期 · {due.length} 台</div>
                        <ul className="space-y-px">
                          {due.map((n) => (
                            <li key={n.id}>
                              <button
                                onClick={() => focusNode(n)}
                                className="flex w-full cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left whitespace-nowrap transition-colors hover:bg-muted"
                              >
                                <span className="truncate">{n.name}</span>
                                {Number.isFinite(n.price) && n.price > 0 && (
                                  <span className="tnum ml-auto pl-2 font-medium">{money(n.price, n.currency)} / {cycleLabel(n.billing_cycle)}</span>
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                        <Tooltip.Arrow className="fill-border" />
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                )
              })}
            </div>
          </Tooltip.Provider>
        </div>

        <div className="min-w-0 flex-1 border-t pt-4 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-sm font-medium">即将到期</div>
            {upcoming.length > 0 && (
              <div className="tnum text-xs text-muted-foreground">
                {upcoming.length} 台{upcomingSum > 0 ? ` · 月均合计 ${moneyOf(upcomingSum, currencyCode)}` : ""}
              </div>
            )}
          </div>
          {upcoming.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">30 天内没有机器到期</p>
          ) : (
            /* 三档互斥分段各自摊开；卡片弹性拉伸填满（封顶 28rem，独一张不独占全宽），
               多了换行——宽度真正随容器走，不固定 */
            <div className="mt-2 max-h-72 space-y-4 overflow-y-auto pr-1">
              {bands.map((band) => band.items.length > 0 && (
                <section key={band.label}>
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                    {band.label} <span className="tnum font-normal">· {band.items.length} 台</span>
                  </div>
                  <ul className="flex flex-wrap gap-2">
                    {band.items.map(({ n, days }) => {
                      const row = rowById.get(n.id)
                      // 紧迫度：0 天红、≤3 天橙、≤7 天黄、其余常规
                      const bar = days === 0 ? "bg-destructive" : days <= 3 ? "bg-orange-500" : days <= 7 ? "bg-yellow-500" : "bg-primary/60"
                      return (
                        <li key={n.id} className="min-w-0 flex-[1_1_14rem] max-w-[28rem]">
                          <button
                            onClick={() => focusNode(n)}
                            className="w-full cursor-pointer rounded-lg border bg-background/40 p-2.5 text-left transition-colors hover:bg-muted/50"
                          >
                            <div className="flex items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">{n.name}</span>
                              <span className={`tnum shrink-0 text-xs font-medium ${days === 0 ? "text-destructive" : days <= 3 ? "text-orange-500" : "text-muted-foreground"}`}>
                                {days === 0 ? "今天" : `${days} 天后`}
                              </span>
                            </div>
                            <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                              <span className="tnum shrink-0">{n.expires_at!.slice(5, 10)}</span>
                              <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                                <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.max(6, 100 - (days / 30) * 100)}%` }} />
                              </div>
                              <span className="tnum shrink-0">{n.expires_at!.slice(0, 4)}</span>
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                              <span className="truncate text-muted-foreground">
                                {Number.isFinite(n.price) && n.price > 0 ? `${money(n.price, n.currency)} / ${cycleLabel(n.billing_cycle)}` : "免费"}
                              </span>
                              <span className="tnum shrink-0 text-muted-foreground">{row?.monthly != null ? `月均 ${moneyOf(row.monthly, currencyCode)}` : ""}</span>
                            </div>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

export function Billing({ nodes, exchangeRates = "", excludeTag = "" }: { nodes: Node[]; exchangeRates?: string; excludeTag?: string }) {
  const [target, setTarget] = useState(readCurrency)
  const currency: BillingCurrency = BILLING_CURRENCIES.find((c) => c.code === target) ?? BILLING_CURRENCIES[0]

  const custom = useMemo(() => parseRateOverrides(exchangeRates), [exchangeRates])
  const needsFx = nodes.some((n) => {
    const code = (n.currency || "").trim().toUpperCase() || "USD"
    return Number.isFinite(n.price) && n.price > 0 && code !== "CNY" && !Object.hasOwn(custom.rates, code)
  })
  const fx = useExchangeRates(needsFx)
  const rates = useMemo<Record<string, number>>(() => ({ ...fx.snapshot.rates, ...custom.rates, CNY: 1 }), [fx.snapshot.rates, custom.rates])

  const rows = useMemo(() => nodes.map((n) => billingRowOf(n, target, rates)), [nodes, target, rates])
  // 命中排除依据的机器（被排除机器）：底部列表照常列出，但两处金额合计不计入
  const excluded = useMemo(() => new Set(nodes.filter((n) => isExcludedByTag(n, excludeTag)).map((n) => n.id)), [nodes, excludeTag])

  // 实际参与折算的币种及其对目标币种的汇率：计费币种里除目标币种本身全列出；缺报价的也列出，和表里的 ≈ 对得上
  const usedFx = useMemo(() => {
    const codes = new Set<string>()
    for (const n of nodes) {
      if (!(Number.isFinite(n.price) && n.price > 0)) continue
      const code = (n.currency || "").trim().toUpperCase() || "USD"
      if (code !== target) codes.add(code)
    }
    return [...codes].sort().map((code) => {
      const from = rates[code]
      const to = rates[target]
      const ok = typeof from === "number" && Number.isFinite(from) && from > 0
        && typeof to === "number" && Number.isFinite(to) && to > 0
      return { code, text: ok ? `1 ${code} = ${(from / to).toLocaleString("zh-CN", { maximumSignificantDigits: 4 })} ${currency.symbol}` : `${code} 缺汇率` }
    })
  }, [nodes, target, rates, currency.symbol])

  const changeCurrency = (next: string) => {
    setTarget(next)
    try {
      localStorage.setItem(CURRENCY_KEY, next)
    } catch {
      // 记不住就只影响这一次会话
    }
  }

  const monthlyTotal = rows.filter((r) => !excluded.has(r.node.id)).reduce((sum, r) => sum + (r.monthly ?? 0), 0)
  const remainingTotal = rows.filter((r) => !excluded.has(r.node.id)).reduce((sum, r) => sum + (r.remaining ?? 0), 0)
  const expired = rows.filter((r) => r.status === "expired").length
  // 未到期含无到期日的机器（长期持有，同首页口径）；0 就写 0，不用「—」这种含糊占位
  const active = rows.filter((r) => r.status !== "expired").length
  // 30 天内到期（含今天）的机器，与日历右侧分段清单同一口径
  const expiring = rows.filter((r) => r.status === "expiring").length

  // 日历选中日：表格只列当天到期的机器；null 为不筛
  const [picked, setPicked] = useState<string | null>(null)
  // 表头排序：null = 默认权重序（站长在面板里排的节点顺序，保留不动），点击循环 升→降→默认
  const [sort, setSort] = useState<Sort | null>(null)
  const shownRows = useMemo(() => {
    const base = picked === null ? rows : rows.filter((r) => r.node.expires_at?.slice(0, 10) === picked)
    if (!sort) return base
    const dir = sort.dir === "asc" ? 1 : -1
    return [...base].sort((a, b) => dir * SORTERS[sort.key](a, b))
  }, [rows, picked, sort])

  // 金额列文案：折好的用目标币种；缺汇率 ≈ 原币种；两者皆无时——价格列是免费（没价格
  // 与价格 0 在 hub 里等价），月均/剩余列没有概念可显示，占位「—」
  const priceText = (r: BillingRow, amount: number | null, fallback: string) => {
    if (amount !== null) return moneyOf(amount, currency.code)
    if (r.original) return `≈${moneyOf(r.original.amount, r.original.currency)}`
    return fallback
  }

  return (
    <Tooltip.Provider delayDuration={200}>
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-medium">账单</h1>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          货币
          <select
            value={target}
            onChange={(e) => changeCurrency(e.target.value)}
            aria-label="展示币种"
            className="rounded-md border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {BILLING_CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>{c.name} ({c.code})</option>
            ))}
          </select>
        </label>
      </div>

      {/* 汇总：剩余总价值、月均总支出两张金额卡在前；台数四张——未到期（含无到期日的长期
          机器，同首页口径）、即将到期（30 天内）、已到期，三张合计正好等于节点总数 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {statCard("剩余总价值", moneyOf(remainingTotal, currency.code), "已付、还没用掉的那一段（已到期与无到期日不计入）")}
        {statCard("月均总支出", moneyOf(monthlyTotal, currency.code), "各节点价格按计费周期摊到每月后求和（免费机器不计入）")}
        {statCard("节点总数", `${rows.length} 台`)}
        {statCard("未到期", `${active} 台`, "含无到期日的机器（长期持有）")}
        {statCard("即将到期", `${expiring} 台`, "30 天内到期（含今天），与日历清单同一口径")}
        {statCard("已到期", `${expired} 台`)}
      </div>

      <BillingCalendar nodes={nodes} rows={rows} currencyCode={currency.code} picked={picked} onPick={setPicked} />

      {/* 逐台列账：表格，窄屏横向滑动；日历选中了日子就只列当天到期的 */}
      <Card className="gap-0 overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/40 text-muted-foreground">
                <SortTh label="名称" k="name" sort={sort} onPick={setSort} align="left" />
                <SortTh label="状态" k="status" sort={sort} onPick={setSort} align="left" />
                <SortTh label="价格" k="price" sort={sort} onPick={setSort} align="right" />
                <SortTh label="周期" k="cycle" sort={sort} onPick={setSort} align="left" />
                <SortTh label="到期时间" k="expires" sort={sort} onPick={setSort} align="left" />
                <SortTh label="月均价" k="monthly" sort={sort} onPick={setSort} align="right" />
                <SortTh label="剩余价值" k="remaining" sort={sort} onPick={setSort} align="right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {shownRows.map((r) => (
                <tr key={r.node.id} className="hover:bg-muted/50">
                  <td className="max-w-[16rem] px-3 py-2 text-sm font-medium">
                    <InfoTooltip text={nodeInfo(r.node)}>
                      <span className="block truncate">{r.node.name}</span>
                    </InfoTooltip>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{statusCell(r)}</td>
                  <td className="tnum whitespace-nowrap px-3 py-2 text-right">{priceText(r, r.price, "免费")}</td>
                  {/* 周期列只认后台记录：免费是一次性的也照写「一次性」（周期与价格两回事），
                      只有真没填周期才占位「—」 */}
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{cycleLabel(r.node.billing_cycle) || "—"}</td>
                  {/* 到期时间可点：日历翻到那个月并选中那一天（表格随之只列当天到期的；
                      再点一次取消筛选）；没到期日的机器没有日历目标，保持「—」 */}
                  <td className="tnum whitespace-nowrap px-3 py-2">
                    {r.node.expires_at ? (
                      <button
                        onClick={() => setPicked(picked === r.node.expires_at!.slice(0, 10) ? null : r.node.expires_at!.slice(0, 10))}
                        title="在日历中查看"
                        className="cursor-pointer underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
                      >
                        {r.node.expires_at.slice(0, 10)}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="tnum whitespace-nowrap px-3 py-2 text-right">{priceText(r, r.monthly, "—")}</td>
                  <td className="tnum whitespace-nowrap px-3 py-2 text-right">
                    {excluded.has(r.node.id) ? (
                      // 被排除的机器：金额照算，但挂一枚 Info 标记，悬浮说明不计入合计的原因
                      <InfoTooltip text={`已排除（公开备注含「${excludeTag}」）：不计入剩余总价值与月均总支出`}>
                        <span className="inline-flex items-center justify-end gap-1 text-muted-foreground">
                          {priceText(r, r.remaining, "—")}
                          <Info className="size-3 shrink-0" aria-hidden />
                        </span>
                      </InfoTooltip>
                    ) : (
                      priceText(r, r.remaining, "—")
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">还没有节点</td></tr>
              )}
              {rows.length > 0 && shownRows.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">{picked} 没有机器到期</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {picked !== null && (
          <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <span>只看 {picked} 到期的机器（{shownRows.length} 台）</span>
            <button onClick={() => setPicked(null)} className="cursor-pointer rounded-md border bg-background px-2 py-0.5 transition-colors hover:bg-muted">
              取消筛选
            </button>
          </div>
        )}
      </Card>

      {/* 汇率口径：折合说明 + 用到的币种实际汇率一眼看清 */}
      <p className="text-xs text-muted-foreground" role="status">
        金额按「1 单位币种 = N {currency.name}」的参考汇率折算{fx.snapshot.date ? `（汇率日期 ${fx.snapshot.date}）` : ""}；缺汇率的机器按原币种显示（≈），免费机器不计入各项合计
        {usedFx.length > 0 && (
          <span className="tnum">
            {" "}
            {usedFx.map((f, i) => (
              <span key={f.code} className="whitespace-nowrap">
                {i > 0 && " · "}
                {f.text}
              </span>
            ))}
          </span>
        )}
      </p>
    </div>
    </Tooltip.Provider>
  )
}