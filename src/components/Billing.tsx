import { useEffect, useMemo, useRef, useState } from "react"
import { Tooltip } from "radix-ui"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { Node } from "@/lib/api"
import { BILLING_CURRENCIES, billingRowOf, moneyOf, type BillingCurrency } from "@/lib/billing"
import { CYCLES, daysUntil, money } from "@/lib/format"
import { parseRateOverrides } from "@/lib/money"
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

/** 一行的状态徽章与到期文案 */
function statusCell(row: ReturnType<typeof billingRowOf>) {
  switch (row.status) {
    case "expired":
      return (
        <>
          <Badge variant="destructive" className="font-normal">已到期</Badge>
          <span className="text-xs text-muted-foreground">{row.daysLeft !== null ? `${-row.daysLeft} 天前` : ""}</span>
        </>
      )
    case "active":
      return row.daysLeft === 0
        ? <Badge variant="secondary" className="font-normal">今天到期</Badge>
        : <Badge variant="secondary" className="font-normal">未到期</Badge>
    case "noexpiry":
      return <Badge variant="secondary" className="font-normal">无期限</Badge>
    case "free":
      return <Badge variant="outline" className="font-normal text-muted-foreground">免费</Badge>
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
 * 到期日历：左边月历（角标当天到期台数、背景色阶、悬浮看清单、点击筛选当天），右边「30 天内到期」卡片清单
 * 选中日子由父组件持有（pick）：日历高亮描边，账单表据此筛选；30 天清单与悬浮面板点击某台机器
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
  const [ym, setYm] = useState({ y: today.getFullYear(), m: today.getMonth() })

  // 30 天内到期（含今天），按剩余天数升序；天数口径与表格状态列同一套 daysUntil
  const upcoming = useMemo(() => {
    return nodes
      .map((n) => ({ n, days: daysUntil(n.expires_at) }))
      .filter((x): x is { n: Node; days: number } => x.days !== null && x.days >= 0 && x.days <= 30)
      .sort((a, b) => a.days - b.days)
  }, [nodes])

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
  const move = (delta: number) => {
    const d = new Date(ym.y, ym.m + delta, 1)
    setYm({ y: d.getFullYear(), m: d.getMonth() })
  }
  const dayKey = (d: number) => `${ym.y}-${String(ym.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`

  // 选中某台机器：日历跳到它到期的月份并选中那一天（表格随之筛选）
  const focusNode = (n: Node) => {
    if (!n.expires_at) return
    const [y, m, d] = n.expires_at.slice(0, 10).split("-").map(Number)
    setYm({ y, m: m - 1 })
    onPick(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`)
  }

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="mx-auto w-full max-w-[19rem] shrink-0 sm:mx-0">
          <div className="mb-2 flex items-center justify-between gap-2">
            <MonthField ym={ym} onChange={setYm} />
            <div className="flex items-center gap-1">
              <button className="tap tap-6 rounded-md text-muted-foreground transition-colors hover:text-foreground" onClick={() => move(-1)} aria-label="上月" title="上月">
                <ChevronLeft className="size-4" />
              </button>
              <button
                className="tap tap-6 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setYm({ y: today.getFullYear(), m: today.getMonth() })}
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
                // 色阶：到期台数越多背景越浓（secondary → primary 过渡），选中日用主色描边
                const heat = due ? Math.min(0.25 + (due.length / maxDue) * 0.75, 1) : 0
                const cell = (
                  <div
                    onClick={due ? () => onPick(picked === key ? null : key) : undefined}
                    className={`relative flex aspect-square items-center justify-center rounded-md text-sm transition-colors ${
                      due ? "cursor-pointer" : ""
                    } ${due ? "font-medium text-foreground" : ""} ${key < todayKey ? "text-muted-foreground/50" : ""} ${
                      key === todayKey ? "ring-1 ring-inset ring-border" : ""
                    } ${picked === key ? "ring-1 ring-primary/60" : ""}`}
                    style={due && heat ? { background: `color-mix(in oklab, var(--primary) ${Math.round(heat * 45)}%, transparent)` } : undefined}
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
            <div className="text-sm font-medium">30 天内到期</div>
            {upcoming.length > 0 && (
              <div className="tnum text-xs text-muted-foreground">
                {upcoming.length} 台{upcomingSum > 0 ? ` · 月均合计 ${moneyOf(upcomingSum, currencyCode)}` : ""}
              </div>
            )}
          </div>
          {upcoming.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">30 天内没有机器到期</p>
          ) : (
            <ul className="mt-2 grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
              {upcoming.map(({ n, days }) => {
                const row = rowById.get(n.id)
                // 紧迫度：0 天红、≤3 天橙、≤7 天黄、其余常规
                const bar = days === 0 ? "bg-destructive" : days <= 3 ? "bg-orange-500" : days <= 7 ? "bg-yellow-500" : "bg-primary/60"
                return (
                  <li key={n.id}>
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
          )}
        </div>
      </div>
    </Card>
  )
}

export function Billing({ nodes, exchangeRates = "" }: { nodes: Node[]; exchangeRates?: string }) {
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

  // 实际参与折算的外币及其有效汇率（1 单位 = N 人民币）；缺报价的也列出，和表里的 ≈ 对得上
  const usedFx = useMemo(() => {
    const codes = new Set<string>()
    for (const n of nodes) {
      if (!(Number.isFinite(n.price) && n.price > 0)) continue
      const code = (n.currency || "").trim().toUpperCase() || "USD"
      if (code !== "CNY" && code !== target) codes.add(code)
    }
    return [...codes].sort().map((code) => {
      const rate = rates[code]
      const ok = typeof rate === "number" && Number.isFinite(rate) && rate > 0
      return { code, text: ok ? `1 ${code} = ${rate.toLocaleString("zh-CN", { maximumSignificantDigits: 4 })} ¥` : `${code} 缺汇率` }
    })
  }, [nodes, target, rates])

  const changeCurrency = (next: string) => {
    setTarget(next)
    try {
      localStorage.setItem(CURRENCY_KEY, next)
    } catch {
      // 记不住就只影响这一次会话
    }
  }

  const priceTotal = rows.reduce((sum, r) => sum + (r.price ?? 0), 0)
  const monthlyTotal = rows.reduce((sum, r) => sum + (r.monthly ?? 0), 0)
  const remainingTotal = rows.reduce((sum, r) => sum + (r.remaining ?? 0), 0)
  const expired = rows.filter((r) => r.status === "expired").length
  const active = rows.filter((r) => r.status === "active").length
  const dueSoon = rows.filter((r) => r.status === "active" && r.daysLeft !== null && r.daysLeft <= 7).length

  // 日历选中日：表格只列当天到期的机器；null 为不筛
  const [picked, setPicked] = useState<string | null>(null)
  const shownRows = picked === null ? rows : rows.filter((r) => r.node.expires_at?.slice(0, 10) === picked)

  const priceText = (r: ReturnType<typeof billingRowOf>, amount: number | null) => {
    if (amount !== null) return moneyOf(amount, currency.code)
    if (r.original) return `≈${moneyOf(r.original.amount, r.original.currency)}`
    return "—"
  }

  return (
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

      {/* 汇总：总价、月均、剩余价值、台数六张，未到期卡悬浮提示 7 日内到期数 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {statCard("总价格", moneyOf(priceTotal, currency.code), "各机器按自身周期的一期价格直接加总（不同周期混在一起，仅供参考）")}
        {statCard("月均总价", moneyOf(monthlyTotal, currency.code), "各节点价格按计费周期摊到每月后求和（免费机器不计入）")}
        {statCard("剩余总价值", moneyOf(remainingTotal, currency.code), "已付、还没用掉的那一段（已到期与无到期日不计入）")}
        {statCard("节点总数", rows.length > 0 ? `${rows.length} 台` : null)}
        {statCard("未到期", active > 0 ? `${active} 台` : null, dueSoon > 0 ? `其中 ${dueSoon} 台 7 天内到期` : undefined)}
        {statCard("已到期", expired > 0 ? `${expired} 台` : null)}
      </div>

      <BillingCalendar nodes={nodes} rows={rows} currencyCode={currency.code} picked={picked} onPick={setPicked} />

      {/* 逐台列账：表格，窄屏横向滑动；日历选中了日子就只列当天到期的 */}
      <Card className="gap-0 overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/40 text-muted-foreground">
                <th className="px-3 py-2 text-left font-normal">名称</th>
                <th className="px-3 py-2 text-left font-normal">状态</th>
                <th className="px-3 py-2 text-right font-normal">价格</th>
                <th className="px-3 py-2 text-left font-normal">周期</th>
                <th className="px-3 py-2 text-left font-normal">到期时间</th>
                <th className="px-3 py-2 text-right font-normal">月均价</th>
                <th className="px-3 py-2 text-right font-normal">剩余价值</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {shownRows.map((r) => (
                <tr key={r.node.id} className="hover:bg-muted/50">
                  <td className="max-w-[16rem] truncate px-3 py-2 text-sm font-medium">{r.node.name}</td>
                  <td className="whitespace-nowrap px-3 py-2">{statusCell(r)}</td>
                  <td className="tnum whitespace-nowrap px-3 py-2 text-right">{priceText(r, r.price)}</td>
                  {/* 周期列只认后台记录：免费是一次性的也照写「一次性」（周期与价格两回事），
                      只有真没填周期才占位「—」 */}
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{cycleLabel(r.node.billing_cycle) || "—"}</td>
                  <td className="tnum whitespace-nowrap px-3 py-2">{r.node.expires_at ? r.node.expires_at.slice(0, 10) : <span className="text-muted-foreground">—</span>}</td>
                  <td className="tnum whitespace-nowrap px-3 py-2 text-right">{priceText(r, r.monthly)}</td>
                  <td className="tnum whitespace-nowrap px-3 py-2 text-right">{priceText(r, r.remaining)}</td>
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
        金额按「1 单位币种 = N 人民币」的参考汇率折算成{currency.name}{fx.snapshot.date ? `（汇率日期 ${fx.snapshot.date}）` : ""}；缺汇率的机器按原币种显示（≈），免费机器不计入各项合计
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
  )
}