import type { Node } from "@/lib/api"
import { daysUntil } from "./format.ts"
import { cycleDaysOf, cycleMonthsOf } from "./money.ts"

/**
 * 账单页这一层：把各节点的价格按访客选中的目标币种统一折算，再逐台列账
 *
 * 汇率口径与首页预算一致——所有内部汇率都是「1 单位币种 = N 人民币」（见 @/lib/money
 * 的 `FX_CNY` 与 @/lib/use-exchange-rates 的动态报价） 折成目标币种：
 *
 *   金额 × rate[from] ÷ rate[to]
 *
 * 这里只做纯计算与金额字符串，页面（@/components/Billing）负责取汇率、选币种与排版
 */

/** 账单页可切换的展示币种：符号 + 中文名，顺序照产品给的清单 */
export type BillingCurrency = { code: string; symbol: string; name: string }

export const BILLING_CURRENCIES: BillingCurrency[] = [
  { code: "AUD", symbol: "A$", name: "澳元" },
  { code: "CAD", symbol: "C$", name: "加元" },
  { code: "CHF", symbol: "CHF", name: "瑞士法郎" },
  { code: "CNY", symbol: "¥", name: "人民币" },
  { code: "EUR", symbol: "€", name: "欧元" },
  { code: "GBP", symbol: "£", name: "英镑" },
  { code: "HKD", symbol: "HK$", name: "港币" },
  { code: "INR", symbol: "₹", name: "印度卢比" },
  { code: "JPY", symbol: "JP¥", name: "日元" },
  { code: "KRW", symbol: "₩", name: "韩元" },
  { code: "NZD", symbol: "NZ$", name: "新西兰元" },
  { code: "RUB", symbol: "₽", name: "俄罗斯卢布" },
  { code: "SGD", symbol: "S$", name: "新加坡元" },
  { code: "TWD", symbol: "NT$", name: "新台币" },
  { code: "USD", symbol: "$", name: "美元" },
]

const SYMBOL: Record<string, string> = Object.fromEntries(BILLING_CURRENCIES.map((c) => [c.code, c.symbol]))

/** 有效汇率（1 单位该币种 = N 人民币）；未知/零/NaN 一律视为缺报价 */
function rateOf(code: string, rates: Record<string, number>): number | undefined {
  const rate = rates[code]
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : undefined
}

/** 把 `amount` 从 `from` 币种折成 `to` 币种；任一方缺汇率返回 null（那一台退回原币种展示） */
export function convert(amount: number, from: string, to: string, rates: Record<string, number>): number | null {
  if (from === to) return amount
  const a = rateOf(from, rates)
  const b = rateOf(to, rates)
  if (a === undefined || b === undefined) return null
  return (amount * a) / b
}

/** 目标币种金额：符号 + 三位一节 + 两位小数（合计上千时才看得出分隔符的价值） */
export function moneyOf(amount: number, currency: string): string {
  const symbol = SYMBOL[currency] ?? `${currency} `
  return `${symbol}${amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * 一台机器的账单状态——**纯到期维度**：有到期日按剩余天数分已到期/即将到期（≤30 天，
 * 含今天）/未到期，没到期日是无期限 免费是价格的事（价格列表达）、一次性是周期的事
 * （周期列表达），都不在这四态里；expiring 与日历清单共用的「即将到期」档
 */
export type BillingStatus = "noexpiry" | "expired" | "active" | "expiring"

export type BillingRow = {
  node: Node
  status: BillingStatus
  /** 距到期的天数（负 = 已过期这么久）；无到期日时为 null */
  daysLeft: number | null
  /**
   * 折成目标币种的价格；没填价格、或源/目标币种缺汇率时为 null
   * （缺汇率时页面退回原币种，见 `original`）
   */
  price: number | null
  /** 折成目标币种的月均价格；周期「一次性」或折不了时为 null */
  monthly: number | null
  /** 折成目标币种的剩余价值（已付未消耗段）；已到期、无到期日或折不了时为 null */
  remaining: number | null
  /** 折不了汇率时保留原样：金额 + 币种（页面用「≈ 原币种」兜底） */
  original: { amount: number; currency: string } | null
}

/**
 * 逐台列账：免费的机器也给一行（价格列标「免费」），这样「所有机器」一张表就看全
 */
export function billingRowOf(node: Node, target: string, rates: Record<string, number>): BillingRow {
  const priced = Number.isFinite(node.price) && node.price > 0
  const source = (node.currency || "").trim().toUpperCase() || "USD"
  const converted = priced ? convert(node.price, source, target, rates) : null

  if (!priced) {
    return { node, status: statusOf(node), daysLeft: daysLeftOf(node), price: null, monthly: null, remaining: null, original: null }
  }
  if (converted === null) {
    return {
      node, status: statusOf(node), daysLeft: daysLeftOf(node),
      price: null, monthly: null, remaining: null,
      original: { amount: node.price, currency: source },
    }
  }

  const months = cycleMonthsOf(node.billing_cycle)
  const days = cycleDaysOf(node.billing_cycle)
  const left = daysLeftOf(node)
  return {
    node,
    status: statusOf(node),
    daysLeft: left,
    price: converted,
    monthly: months > 0 ? converted / months : null,
    // 线性折算：日单价 × 剩余天数，不按一个周期封顶（一次付多期时剩余就超过一期价，
    // 见 money.ts 的同一口径）
    remaining: days > 0 && left !== null && left > 0 ? converted * (left / days) : null,
    original: null,
  }
}

function daysLeftOf(node: Node): number | null {
  return typeof node.expires_in === "number" ? node.expires_in : daysUntil(node.expires_at)
}

/** 已到期 / 即将到期 / 未到期 / 无期限，四选一（与价格、周期无关） */
function statusOf(node: Node): BillingStatus {
  const left = daysLeftOf(node)
  if (left === null) return "noexpiry"
  return left < 0 ? "expired" : left <= 30 ? "expiring" : "active"
}