import type { Node } from "@/lib/api"
// 相对路径（而不是 `@/lib/format`）：这个文件要能被 `node src/lib/money.test.ts`
// 直接跑（见 money.test.ts），而 Node 不认 tsconfig 里的 `@` 别名
import { daysUntil } from "./format.ts"
import { splitTags } from "./notes.ts"

/**
 * 概览卡片「预算版」那两块读数：剩余总价值、月均总支出（与账单页统计卡同名）
 *
 * 两个数都来自 `/api/nodes` 里本来就有的 `price` / `currency` / `billing_cycle` /
 * `expires_in`；汇率由页面统一提供，计费周期与到期口径不受汇率更新影响
 *
 * 口径：
 *   月均总支出 = Σ 价格 × 汇率 ÷ 周期月数——把每个节点的账摊到一个月上再加起来
 *     （年付 $120 就是每月 $10）hub 的自定义 `<n>m` 支持 1–1200 月
 *     一次性买断（`once`）没有「每月」可言，不计入；价格没填（0/空）的不计
 *   剩余总价值 = Σ 价格 × 汇率 × (剩余天数 ÷ 周期天数)——已经付掉、还没用掉的那一段
 *     周期天数取到期日倒推一个周期的实际日历天数（见 cycleDaysOf），
 *     剩余天数铺满一个周期时剩余价值正好等于一期付款
 *     线性折算不封顶：到期日比一个周期远说明一次付了多期
 *     剩余天数取 hub 算好的 `expires_in`（它按 hub 的日历算，在线节点还会顺延到期日），
 *     旧 hub 没有这个字段时才退回按 `expires_at` 自己数
 *     无到期日（`expires_in` 与 `expires_at` 都没有）的机器没有「剩多少价值」可说，
 *     不计入；已经过期的按 0 计（不会出现负数）
 *   没写周期（空串 / 不认识的取值，老数据或手填）按最常见的**月付**算——它读起来
 *   最接近「这台机器一个月花多少」，也不会让那个节点整台从合计里消失
 */
/** 命名周期与一次性对应的月数；`<n>m` 由正则解析，不进这张表 */
const CYCLE_MONTHS: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  yearly: 12,
  biennial: 24,
  triennial: 36,
  once: 0,
}

/** 周期的月数；没写或认不出（老数据 / 手填）按月付，不让节点从合计里消失 */
export function cycleMonthsOf(cycle: string): number {
  if (Object.hasOwn(CYCLE_MONTHS, cycle)) return CYCLE_MONTHS[cycle]
  const n = Number(/^(\d+)m$/.exec(cycle)?.[1])
  return Number.isInteger(n) && n >= 1 && n <= 1200 ? n : 1
}

/**
 * 一个计费周期的实际天数：从到期日倒推一个周期得到起点（整年的按年倒推，其余按月），
 * 起点到到期日的日历天数。倒推出的日子不存在（月末、闰日）时起点回退到当月最后一天。
 * 一次性返回 0；无到期日或日期无效时退回月数 × 30 的平均尺。
 */
export function cycleDaysOf(cycle: string, expiresAt: string | null | undefined): number {
  const months = cycleMonthsOf(cycle)
  if (months <= 0) return 0
  const fallback = months * 30
  if (!expiresAt) return fallback
  const end = new Date(`${expiresAt.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(end.getTime())) return fallback
  const endMs = end.getTime()
  const day = end.getDate()
  if (months % 12 === 0) end.setFullYear(end.getFullYear() - months / 12)
  else end.setMonth(end.getMonth() - months)
  if (end.getDate() !== day) end.setDate(0)
  const span = Math.round((endMs - end.getTime()) / 86_400_000)
  return span > 0 ? span : fallback
}

/**
 * 固定汇率：1 单位该币种 = N 人民币
 *
 * 历史参考表保留纯函数的默认口径，供旧调用及回归使用 首页预算会传入自动更新、缓存或
 * 随主题打包的完整参考报价，不再依赖这里的 13 币种表 卡片的人民币折算仍为「≈」
 * 原表日期为 `FX_DATE`，后补币种的日期与来源单独记录在 `FX_REFERENCES`
 *
 * 取值：2026-09-30 的公开汇率参考价，四舍五入到四位小数
 */
export const FX_DATE = "2026-09-30"

/** 新增币种的官方取价证据；其余币种保留原表与原日期 */
const ECB_REFERENCE_SOURCE = "https://data-api.ecb.europa.eu/service/data/EXR/D.CNY+HUF+NOK.EUR.SP00.A?startPeriod=2026-10-09&endPeriod=2026-10-09&format=csvdata"
export const FX_REFERENCES: Record<string, { date: string; source: string }> = {
  HUF: { date: "2026-10-09", source: ECB_REFERENCE_SOURCE },
  NOK: { date: "2026-10-09", source: ECB_REFERENCE_SOURCE },
}

export const FX_CNY: Record<string, number> = {
  CNY: 1,
  USD: 6.7179,
  EUR: 7.6172,
  GBP: 8.883,
  JPY: 0.0427,
  HKD: 0.8562,
  TWD: 0.211,
  SGD: 5.2585,
  AUD: 4.6909,
  CAD: 4.7351,
  RUB: 0.0795,
  // ECB 2026-10-09：1 EUR = 7.4992 CNY = 365.08 HUF = 10.7155 NOK
  // 用同日 EUR 交叉价，计算保留精度，只在提示显示时四舍五入
  HUF: 7.4992 / 365.08,
  NOK: 7.4992 / 10.7155,
}

/** 无效、零或继承来的汇率都不能拿来折算，尤其不能把未知币种当作 0 元 */
function rateOf(currency: string, rates: Record<string, number> = FX_CNY): number | undefined {
  const rate = Object.hasOwn(rates, currency) ? rates[currency] : undefined
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : undefined
}

export type Budget = {
  /** 折成人民币的月均总支出；一台可计的都没有时 null（卡片显示「—」而不是 ¥0.00） */
  monthly: number | null
  /** 折成人民币的剩余总价值合计；同上 */
  remaining: number | null
  /** 计入月均总支出的机器数 */
  monthlyCount: number
  /** 计入剩余总价值的机器数（剩余天数 > 0 的） */
  remainingCount: number
  /** 真的折进去过的币种，按字母序（用来在提示里只列该报的那几条汇率） */
  used: string[]
  /** 填了价格、但汇率表里没有的那种币种（那台机器因此没计入，提示里会说明） */
  skipped: string[]
  /**
   * 逐台的**月摊**明细（金额降序、同额保持原顺序）——「月均总支出」那块读数悬停时弹出的浮层
   * 用它回答「合起来这些钱，是哪几台摊出来的」 口径与 `monthly` 完全同一份：一次性买断、
   * 没填价格、汇率表里没有的机器都不在这里出现（所以 `monthlyItems.length === monthlyCount`）
   */
  monthlyItems: BudgetItem[]
  /**
   * 逐台的**剩余价值**明细（金额降序、同额保持原顺序）——「剩余总价值」那块的浮层用它
   * 口径与 `remaining` 同一份：无到期日、一次性买断、已经过期的机器都不在这里出现
   * （所以 `remainingItems.length === remainingCount`）
   */
  remainingItems: BudgetItem[]
}

/** 逐台明细里的一条（月摊与剩余价值共用；`amount` 都是折算后的人民币金额） */
export type BudgetItem = {
  /** 机器名（原样显示；浮层里过长由 CSS 截断） */
  name: string
  /** 折成人民币的金额：月摊版是「每月多少」，剩余价值版是「还剩多少」 */
  amount: number
}

/**
 * 排除依据是否命中这台机器：公开备注按逗号/分号（均含全角）拆分后，
 * 其中一项与依据**完全相同**（trim 后比较，区分大小写）才算命中；依据为空永不命中
 */
export function isExcludedByTag(node: { public_remark?: string | null }, tag: string): boolean {
  const key = tag.trim()
  if (!key) return false
  return splitTags(node.public_remark ?? "").includes(key)
}

export function budgetOf(nodes: Node[], rates: Record<string, number> = FX_CNY, excludeTag = ""): Budget {
  let monthly = 0
  let remaining = 0
  let monthlyCount = 0
  let remainingCount = 0
  const used = new Set<string>()
  const skipped = new Set<string>()
  const monthlyItems: BudgetItem[] = []
  const remainingItems: BudgetItem[] = []

  for (const node of nodes) {
    // 命中排除依据的机器不进合计（被排除机器：填了价格但不想计入账单）
    if (isExcludedByTag(node, excludeTag)) continue
    // 没填价格（0 / 空）＝这台不计账，不是「花 0 元」
    if (!Number.isFinite(node.price) || !(node.price > 0) || node.billing_cycle === "once") continue
    const currency = (node.currency || "").trim().toUpperCase()
    const fx = rateOf(currency, rates)
    if (fx === undefined) {
      skipped.add(currency || "（空）")
      continue
    }
    used.add(currency)
    const months = cycleMonthsOf(node.billing_cycle)
    const days = cycleDaysOf(node.billing_cycle, node.expires_at)
    if (months > 0) {
      const per = (node.price * fx) / months
      monthly += per
      monthlyCount++
      monthlyItems.push({ name: node.name, amount: per })
    }
    if (days <= 0) continue
    // `expires_in` 是数字（含 0、负数）就用它；null / 缺字段才按 `expires_at` 自己数
    const left = typeof node.expires_in === "number" ? node.expires_in : daysUntil(node.expires_at)
    if (typeof left === "number" && left > 0) {
      // 线性折算：日单价 × 剩余天数。不按一个周期封顶——到期日比一个周期远，
      // 说明站长一次付了多期（月付剩 43 天＝付了约 1.43 期），已付未用的就是 43 天的量
      const worth = node.price * fx * (left / days)
      remaining += worth
      remainingCount++
      remainingItems.push({ name: node.name, amount: worth })
    }
  }

  return {
    monthly: monthlyCount ? monthly : null,
    remaining: remainingCount ? remaining : null,
    monthlyCount,
    remainingCount,
    used: [...used].sort(),
    skipped: [...skipped].sort(),
    // 降序（贵的在前）——「钱花在哪台上了」是明细浮层要回答的第一个问题；
    // 同金额的保持节点原顺序（sort 在 ES2019+ 是稳定的）
    monthlyItems: monthlyItems.sort((a, b) => b.amount - a.amount),
    remainingItems: remainingItems.sort((a, b) => b.amount - a.amount),
  }
}

/**
 * 人民币金额 三位一节的逗号是必要的：这是合计，几千块的时候没有分隔符要一位位去数
 * 两位小数与卡片上单机的「价格」一致（`money()`）
 */
export function cny(amount: number): string {
  return `¥${amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** 提示里那句汇率说明 只列真的用到的币种（人民币自身不必写「1 CNY = ¥1」） */
export type RateReference = {
  rates: Record<string, number>
  date: string
  /** 管理员的自定义汇率独立标记，不能冒用自动报价的日期 */
  custom?: Record<string, number>
  label: string
}

export function fxNote(used: string[], skipped: string[] = [], reference?: RateReference): string {
  const table = reference?.rates ?? FX_CNY
  const dates = new Map<string, string[]>()
  const missing = new Set(skipped)
  for (const code of new Set(used.map((currency) => currency.trim().toUpperCase()))) {
    const rate = rateOf(code, table)
    if (rate === undefined) {
      missing.add(code || "（空）")
      continue
    }
    if (code === "CNY") continue
    const date = reference
      ? reference.custom && Object.hasOwn(reference.custom, code) ? "自定义" : reference.date
      : Object.hasOwn(FX_REFERENCES, code) ? FX_REFERENCES[code].date : FX_DATE
    const group = dates.get(date) ?? []
    group.push(`1 ${code} = ¥${trimRate(rate)}`)
    dates.set(date, group)
  }
  const rates = [...dates].map(([date, group]) => `${group.join("，")}，${date}`)
  const label = reference?.label ?? "按固定汇率折算"
  const head = rates.length ? `${label}（${rates.join("；")}）` : `${label}成人民币`
  const miss = missing.size ? `；${[...missing].sort().join("、")} 没有汇率，未计入` : ""
  return head + miss
}

/** 任意三字母币种可人工补价；1 单位该币种 = N 人民币 格式不明的行直接拒绝 */
export function parseRateOverrides(text: string): { rates: Record<string, number>; invalid: number } {
  const rates: Record<string, number> = Object.create(null)
  // 拒绝整项，避免截到行中间后把 USD=7.1234 误读为 USD=7
  if (text.length > 16_384) return { rates, invalid: 1 }
  let invalid = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^([A-Za-z]{3})\s*=\s*((?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?)$/.exec(line)
    const code = match?.[1].toUpperCase()
    const value = match ? Number(match[2]) : NaN
    if (!code || !Number.isFinite(value) || value < 1e-12 || value > 1e12 || (code === "CNY" && value !== 1)) {
      invalid++
      continue
    }
    rates[code] = value
  }
  return { rates, invalid }
}

/** 最多八位小数，避免小币值交叉汇率过早取整；原表去掉尾零后仍显示原值 */
function trimRate(rate: number): string {
  if (rate > 0 && rate < 1e-8) return rate.toPrecision(8)
  return rate.toFixed(8).replace(/\.?0+$/, "")
}
