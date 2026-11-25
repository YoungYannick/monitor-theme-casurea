import type { Node } from "./api.ts"

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"]

const unitOf = (n: number) => Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1)

/**
 * 1024-based, as VPS dashboards and `df` report bytes, but labelled MB/GB the way
 * `df -h` and hosting plans write them: no plan is sold as "1000 GiB", and the two
 * extra letters push the memory and traffic lines past their column.
 *
 * Three significant digits by default. Two decimals throughout would end the
 * card's lines in an ellipsis on a four-column grid; a pair sharing a unit
 * recovers them through pair() below.
 */
export function bytes(n: number, digits?: number): string {
  // `< 1` rather than `< 0`: a fraction of a byte puts `unitOf` at -1 and prints
  // "512 undefined". 非有限值同理（`bytes(Infinity)` 曾印「Infinity PB」）——
  // 这类值只可能来自坏样本（agent 报了个溢出数），当 0 比印一串天文数字有用
  if (!Number.isFinite(n) || n < 1) return "0 B"
  let i = unitOf(n)
  let v = n / 1024 ** i
  const places = () => (i === 0 ? 0 : (digits ?? (v >= 100 ? 0 : v >= 10 ? 1 : 2)))
  // 四舍五入之后可能正好顶到 1024（1023.6 B → 「1024 B」、1048575 B → 「1024 KB」）：
  // 数值与单位对不上，读起来是个坏数 顶到就升一档重算；PB 是最后一档，原地印
  // （rate() 早就有这条进位规则，bytes / axisBytes 是后补的 —— 2026-11-06）
  if (Number(v.toFixed(places())) >= 1024 && i < UNITS.length - 1) {
    i += 1
    v = n / 1024 ** i
  }
  // 与 rate() 同一条：PB 是最后一档，再往上是天文数字（`bytes(1e30)` 会印
  // 「888178419700125 PB」），夹在 999 —— 卡片上那一格放不下一串十五位数
  if (i === UNITS.length - 1) v = Math.min(v, 999)
  return `${v.toFixed(places())} ${UNITS[i]}`
}

/**
 * A "used / total" pair. Sharing a unit means writing it once, and those four
 * characters are what allow the two decimals: 111px against the 122px a card in
 * the four-column grid provides, where separate units require 132px. A pair
 * spanning two units has nothing to save and falls back to bytes().
 */
export function pair(used: number, total: number): string {
  // 非有限值/负数一律当 0：`bytes(Infinity)` 会印「Infinity PB」、负值会让 `unitOf` 给出
  // 越界档位 这两个入口在调用方看起来都是「一个合法的 number」，不能指望它们自己过滤
  const u0 = Number.isFinite(used) && used > 0 ? used : 0
  const t0 = Number.isFinite(total) && total > 0 ? total : 0
  const unit = u0 > 0 && t0 > 0 && unitOf(u0) === unitOf(t0) ? unitOf(t0) : -1
  if (unit >= 0) {
    const f = (n: number, power: number) => (n / 1024 ** power).toFixed(power === 0 ? 0 : 2)
    // ★两侧都要判（2026-11-07 二审）：只判 total 时「用超套餐但没超太多」那一小段会印出
    //   「1024 / 1023 B」—— 左边四舍五入顶到 1024、单位却还是小的一档used 先顶到就一起升档，
    //   升档后 used 仍 ≥1024 是真的超额（30 GB 套餐用了 102 GB），那时印 100+ 是正确读数
    // ★哪一侧顶到 1024，就只让**那一侧**升档（2026-11-21 三审）：原先两侧一起升，
    //   `pair(1023.4, 1023.6)` 于是印「1.00 / 1.00 KB」—— 而 `bytes(1023.4)` 印的是
    //   「1023 B」 实际用量 1023 B 被凭空放大成 1 KB，卡片上那一格就成了假读数
    //   现在的规则：先按原档印；某一侧四舍五入后到 1024，只把那一侧换成更高一档
    const top = UNITS.length - 1
    const part = (n: number): string => {
      let power = unit
      // 至多升一档就够了（1023.999 B → 1.00 KB）；若那一档还是 ≥1024（真的超额），
      // 继续升到顶档为止，最后夹 999（与 bytes 同一条夹子）
      while (power < top && Number(f(n, power)) >= 1024) power += 1
      const value = n / 1024 ** power
      if (power >= top) return `${Math.min(value, 999).toFixed(2)} ${UNITS[top]}`
      return `${f(n, power)} ${UNITS[power]}`
    }
    const left = part(u0)
    const right = part(t0)
    // 两侧落在同一档时合成「x / y UNIT」（卡片上那一格最紧凑的写法）；
    // 跨档（一侧升了、另一侧没升）就各自带单位 —— 否则读者会以为两个数同档
    const lu = left.slice(left.lastIndexOf(" ") + 1)
    const ru = right.slice(right.lastIndexOf(" ") + 1)
    if (lu === ru) return `${left.slice(0, left.lastIndexOf(" "))} / ${right.slice(0, right.lastIndexOf(" "))} ${lu}`
    return `${left} / ${right}`
  }
  return `${bytes(u0)} / ${bytes(t0)}`
}

/**
 * Axis ticks. Whole units are too coarse for a narrow band -- a disk at 3.2 GB
 * would draw 3 GB, 2 GB, 2 GB, 811 MB, 0 B, repeating a label -- so ticks under
 * three digits keep one decimal. Above that the next tick is a whole unit away
 * and the label must stay within the axis.
 */
export function axisBytes(v: number): string {
  if (!v || v < 0) return "0 B"
  const unit = Math.min(Math.floor(Math.log(v) / Math.log(1024)), 5)
  return bytes(v, v / 1024 ** unit >= 100 ? 0 : 1).replace(".0 ", " ")
}

/**
 * A transfer rate. Same three-significant-digits rule as `bytes`, plus two that
 * exist purely for width: the KB bin never prints a decimal, and every bin stops
 * at 999. Both come from the summary cards, where two rates share one 50/50 row
 * and the narrowest cell is 77px of text. With the rule above the longest reading
 * is "999 KB/s" (71px). The cost is one significant digit below 100; the one
 * decimal under 10 stays.
 */
export function rate(n: number): string {
  // `< 1` for the same reason as bytes(): a fraction of a byte puts unitOf at -1;
  // 非有限值同样归零（原先印「Infinity PB/s」）
  if (!Number.isFinite(n) || n < 1) return "0 B/s"
  let i = unitOf(n)
  let v = n / 1024 ** i
  // `i < UNITS.length - 1`：进位不能越过 PB —— 一份离谱的大数（Infinity、1e30）会
  // 走到最后两档，越界后印出 "undefined PB/s" 到顶就留在 PB 档照原样打印
  if (v >= 999.5 && i < UNITS.length - 1) {
    i += 1
    v = n / 1024 ** i
  }
  // ★PB 是最后一档、上面那道进位写到头就停：`rate(1024**6-1)` 会印「1024 PB/s」、
  //   `rate(1e30)` 印一串十五位数字 —— 与「每一档都停在 999」的设计自相矛盾，也会在
  //   卡片的 50/50 格子里被省略号截断到顶就夹在 999，让人一眼看出「这是个离谱的大数」
  if (i === UNITS.length - 1) v = Math.min(v, 999)
  return `${v.toFixed(i >= 1 && v < 10 ? 1 : 0)} ${UNITS[i]}/s`
}

export function percent(used: number, total: number): number {
  // 夹到 0..100 两端：负数（坏样本 / 负的差值）原先会印出「-33.33%」，进度条还按它
  // 画成反向；非有限值同理归零
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.max(0, (used / total) * 100))
}

export function uptime(seconds: number): string {
  // ★负数与非有限值都当「没有读数」（2026-11-21 三审）：`uptime(-90)` 原先印「-2 分」——
  //   hub 那边 uptime 来自 agent 的开机时长，时钟回拨/重启中途会给负数
  if (!Number.isFinite(seconds) || seconds < 0) return "—"
  if (!seconds) return "—"
  // 不到 1 分钟单独说：原先 `uptime(0.9)` 印「0 分」，读者会以为「刚重启」与「未知」一样
  if (seconds < 60) return "不到 1 分钟"
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d > 0 ? `${d} 天 ${h} 小时` : h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`
}

/** 优先用 Hub 的离线秒数；null 不补造时长，旧 Hub 缺字段时才按访客时钟回退 */
export function offlineSeconds(node: { last_seen: number; last_seen_ago?: number | null }, nowMs = Date.now()): number | null {
  if (node.last_seen_ago !== undefined) {
    return typeof node.last_seen_ago === "number" && Number.isFinite(node.last_seen_ago) && node.last_seen_ago >= 0
      ? node.last_seen_ago : null
  }
  if (!Number.isFinite(node.last_seen) || node.last_seen <= 0 || !Number.isFinite(nowMs)) return null
  return Math.max(0, nowMs / 1000 - node.last_seen)
}

/** Whole days until a date, negative once it has passed. */
export function daysUntil(date?: string | null): number | null {
  if (!date) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  if (!m) return null
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  // ★`Number.isNaN(target)` 是死判据（2026-11-21 三审）：`Date.UTC(2026, 12, 45)` 不返回 NaN，
  //   它把越界月份/日期**正常进位**（2026-13-45 → 2027-02-14）于是 `daysUntil("2026-13-45")`
  //   返回 85 天、`daysUntil("2026-02-30")` 返回 -264 —— 两个都不存在的日期给出了貌似正常的
  //   天数 正则通过后必须回读核对三个字段有没有被进位
  if (Number.isNaN(target)) return null
  const d = new Date(target)
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return null
  }
  const day = 86_400_000
  const beijing = 8 * 3_600_000
  const index = (ms: number) => Math.floor((ms + beijing) / day)
  return index(target) - index(Date.now())
}

/**
 * No expiry and no traffic cap are both rendered as the absence of a ceiling.
 * U+221E rather than the emoji, which arrives as a coloured tile from whatever
 * font the visitor has; this inherits the text colour and size.
 */
export const FOREVER = "∞"

const SYMBOLS: Record<string, string> = { USD: "$", CNY: "¥", EUR: "€", GBP: "£", JPY: "¥" }

/** 币种对应的符号；表里没有的币种返回空串（金额那一半会退化成后缀的 ISO 代码） */
export function currencySymbol(currency: string): string {
  return SYMBOLS[(currency ?? "").trim().toUpperCase()] ?? ""
}

/**
 * 金额里去掉符号的那半段 有符号时只给数字，没符号时把代码缀在后面——和 money() 同一套规则
 * 分开是为了「符号单独占一列」的排版：符号进下面那枚读数盒的图标位，数字留在文字位
 */
export function moneyAmount(amount: number, currency: string): string {
  // ★币种缺失时只印数字（2026-11-21 三审）：原先 `moneyAmount(12, undefined)` 印
  //   「12.00 undefined」、`null` 印「12.00 null」—— 卡片侧三个调用点都是直接透传
  //   `node.currency`，老 hub 或手填数据缺这个键时访客就会看到这串字
  //   口径与 money.ts 的 `(node.currency || "").toUpperCase()` 一致
  const code = (currency ?? "").trim().toUpperCase()
  if (!code) return amount.toFixed(2)
  return SYMBOLS[code] ? amount.toFixed(2) : `${amount.toFixed(2)} ${code}`
}

export function money(amount: number, currency: string): string {
  return `${currencySymbol(currency)}${moneyAmount(amount, currency)}`
}

export const CYCLES: Record<string, string> = {
  monthly: "月付",
  quarterly: "季付",
  semiannual: "半年付",
  yearly: "年付",
  biennial: "两年付",
  triennial: "三年付",
  once: "一次性",
}

/** 宽卡底注那行「价格 / 周期」用的短名（一行 16px 的小字里放不下「月付」这种长名） */
export const CYCLE_SHORT: Record<string, string> = {
  monthly: "月",
  quarterly: "季",
  semiannual: "半年",
  yearly: "年",
  biennial: "两年",
  triennial: "三年",
  once: "一次性",
}

/** Human-readable labels for named and custom whole-month billing cycles. */
export function cycleLabel(cycle: string, short = false): string | null {
  const named = (short ? CYCLE_SHORT : CYCLES)[cycle]
  if (named) return named
  const months = Number(/^(\d+)m$/.exec(cycle)?.[1])
  if (Number.isInteger(months) && months >= 1 && months <= 1200) return `${months} 个月`
  return cycle || null
}

// Hoisted out of `clock`: constructing an Intl formatter per call is the largest
// single cost on the detail page. The zone now resolves once, which only an OS
// timezone change under an open tab would notice. Both take epoch milliseconds,
// which is what the charts feed their time axis; the hub answers in seconds.
const HHMM = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" })

const MDHHMM = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
})

/** 只到日：一周以上的窗口一格跨几天甚至几个月，时分是噪声（见 clockFor） */
const MD = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" })

export function clock(ms: number): string {
  return HHMM.format(ms)
}

/**
 * Axis ticks for a window `hours` wide. Beyond a day a bare "14:00" recurs each
 * midnight and the axis no longer indicates which day it refers to; beyond a week
 * the minutes are noise too (hub 1.3.2 起保留天数可到 365 天，30 天那种窗口一格跨几天，
 * 再带时分只会把标签挤成一团)，所以只留日期
 */
export function clockFor(hours: number): (ms: number) => string {
  if (hours <= 24) return clock
  return hours <= 168 ? (ms: number) => MDHHMM.format(ms) : (ms: number) => MD.format(ms)
}

/**
 * Distro and CPU names as vendors write them carry mostly redundant text: a
 * codename in brackets, "GNU/Linux", "(R)", a core count already printed
 * separately. Stripping it is what makes the line fit.
 */
export function osName(name: string): string {
  return name.replace("GNU/Linux ", "").replace(/\s*\([^)]*\)\s*$/, "")
}

export function cpuName(name: string): string {
  return name
    .replace(/\((R|TM|r|tm)\)/g, "")
    .replace(/\s+(CPU|Processor)\b/g, "")
    .replace(/\s+\d+-Core\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

// Ticks on round clock values across `[from, to]`, in epoch milliseconds:
// the smallest step from the ladder keeping the count under `count`, phased on
// local midnight so a daily tick lands on the day even in a zone offset by 30
// or 45 minutes.
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080,
  // 一周以上的窗口要走完这座阶梯（hub 保留天数可到 365 天）：补上 14 / 30 / 60 / 90 / 180 天，
  // 最长的窗口落在 90 天那一档，八条左右
  20160, 43200, 86400, 129600, 259200].map((m) => m * 60_000)

export function timeTicks(from: number, to: number, count = 8): number[] {
  const step = TICK_STEPS.find((s) => (to - from) / s <= count) ?? TICK_STEPS[TICK_STEPS.length - 1]
  const zone = new Date(from).getTimezoneOffset() * 60_000
  const ticks: number[] = []
  for (let t = Math.ceil((from - zone) / step) * step + zone; t <= to; t += step) ticks.push(t)
  return ticks
}

/**
 * A zero-anchored axis top for a quantity with no capacity to measure against: a
 * utilisation percentage, a load average, a transfer rate.
 *
 * Derived from the gridline rather than the reverse -- the smallest round step
 * whose fourth multiple clears the data. Chosen the other way, the top is round
 * while the four gridlines beneath it are not: a ceiling of 75% draws lines at
 * 18.75 and 56.25. `base` is 1024 for a quantity written in binary units, so the
 * steps are round in the unit it is printed in.
 *
 * `floor` keeps an idle machine looking idle: tracked exactly, a host that never
 * exceeds 0.4% CPU would get an axis of 0-0.4 and render every scheduler blip as
 * a peak.
 */
export function axisTop(max: number, floor: number, base = 10, cap = Infinity): number {
  // ★非有限值先归零（2026-11-21 三审）：`axisTop(Infinity)` 原先一路算出 Infinity 并返回，
  //   而 `quarters(Infinity)` 得到 [NaN×5] —— NodeDetail 的 `+((4 - top % 4) % 4)` 于是变成
  //   NaN、Y 轴刻度全丢 这与同文件 bytes/rate/percent 已经做的「非有限值归零」自相矛盾
  //   来源是 safeNodes 曾放行的 Infinity（那条也一起修了），但函数自己也要挡
  const safeMax = Number.isFinite(max) ? max : 0
  const safeFloor = Number.isFinite(floor) ? floor : 1
  const target = Math.min(cap, Math.max(safeMax, safeFloor)) / 4
  const scale = base ** Math.floor(Math.log(target) / Math.log(base))
  const step = LADDER[base].map((m) => m * scale).find((n) => n >= target)
  return Math.min(cap, (step ?? target) * 4)
}

/**
 * Round multipliers, per base. A decade of base 1024 spans 1024, so a decimal
 * ladder cannot reach across one: with `scale` at 1024^k the largest step it
 * offers is 10 · 1024^k, leaving any target above that unmatched and falling
 * through to `top = max` -- no round step and no round gridlines, which is what
 * this function exists to provide. That held only for a peak within
 * [4, 40) · 1024^k, so a byte axis was more often wrong than right: 40 KB/s to
 * 4 MB/s, the ordinary range for a VPS, drew 2.9 MB with quarters at 732.4 KB.
 *
 * Powers of two for base 1024, with no half-step between them. The four ticks are
 * `step · [1, 2, 3, 4]`, so the third constrains the ladder: `3m` must land on a
 * label `axisBytes` can print, and it prints one decimal. Every power of two does
 * (3 · 512 Ki = 1.5 Mi); the half-steps 384 and 768 do not, their third gridline
 * being 1.125 Ki and 2.25 Ki, printed as "1.1" and "2.3" -- one incorrect label
 * beneath a top and two gridlines that are correct. Those two rungs would be
 * selected for peaks in (1, 1.5] and (2, 3] · 1024^k, that is 1-1.5 MB/s and
 * 2-3 MB/s, within the range named above. The cost of dropping them is a top that
 * may overshoot the data by 2x rather than 1.5x.
 */
const LADDER: Record<number, number[]> = {
  10: [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10],
  1024: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024],
}

/**
 * The gridlines for a zero-anchored axis: the top and the three quarters beneath
 * it.
 *
 * Specified explicitly rather than left to recharts, which selects "nice" decimal
 * values whatever domain it is given -- a top of 30 MiB returns 7.6, 15.3, 22.9,
 * 30, neither quarters nor round in the unit they are printed in.
 */
export function quarters(top: number): number[] {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => top * f)
}

/**
 * Hampel filter (Hampel 1974; MATLAB ships it as `hampel`). A sample more than
 * `sigmas` robust deviations from the median of its window is replaced by that
 * median, while everything else passes through unchanged, which is what
 * separates it from a rolling median or a moving average: a period that is
 * genuinely slow keeps its height, since its own neighbours are slow too.
 *
 * 1.4826 rescales the median absolute deviation to a standard deviation for
 * normally distributed data; 3 sigma is the conventional cut.
 *
 * The deviation is floored at one millisecond, the resolution round trips are
 * stored in. Unfloored, a window whose samples mostly repeat one value -- which
 * is what a steady route looks like at that resolution -- has a deviation of
 * exactly 0, and the test then either rejects nothing or rejects every sample
 * that is not the median, depending on which way the comparison is written. Both
 * fail on the very chart this exists for: a flat line with one 2 s bucket in it.
 * The floor puts the cut at 4.5 ms for a line that does not move.
 *
 * A null is a timeout rather than a high reading, so it is neither replaced nor
 * counted towards what its neighbours are compared against.
 */
export function despike(values: (number | null)[], window = 7, sigmas = 3): (number | null)[] {
  const half = window >> 1
  // ponytail: the window is re-collected per sample. A day of one probe is 1,438
  // of them; a rolling structure would only pay off on a far longer window.
  return values.map((v, i) => {
    if (v === null) return v
    const near = values.slice(Math.max(0, i - half), i + half + 1).filter((n) => n !== null)
    const mid = median(near)
    const mad = Math.max(median(near.map((n) => Math.abs(n - mid))), 1)
    return Math.abs(v - mid) > sigmas * 1.4826 * mad ? mid : v
  })
}

/** The middle of a sorted copy, the mean of the middle pair for an even count. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const half = sorted.length >> 1
  return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2
}


const STEPS = [1, 2, 2.5, 5, 10]

export function niceScale(lo: number, hi: number, count = 4): { lo: number; hi: number; ticks: number[] } {
  if (!(hi > lo)) {
    const pad = Math.abs(hi) > 1 ? Math.abs(hi) * 0.1 : 1
    lo = hi >= 0 ? Math.max(0, lo - pad) : lo - pad
    hi += pad
  }
  const raw = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, Number.MIN_VALUE)))
  const step = STEPS.map((m) => m * mag).find((n) => n >= raw) ?? raw
  const low = Math.floor(lo / step) * step
  const high = Math.ceil(hi / step) * step
  // ★刻度保留几位**跟着步长走**（2026-11-21 三审）：原先写死 `Math.round(v * 1e6) / 1e6`，
  //   于是量程小于 1e-6 时每个刻度都被舍成 0 —— `niceScale(0, 1e-9)` 给出
  //   `ticks = [0, 0, 0, 0, 0]` 图表那边网格线与 Y 轴文字都用 `key={`g${v}`}`，
  //   五个 0 撞成同一个 key：React 只画得出其中一条网格线，刻度标签也全叠在轴底
  //   步长是 1/2/2.5/5 × 10^k，所以「k 的小数位 + 1」位就足够精确（0.25 要两位）
  // 步长是 1/2/2.5/5 × 10^k，`-k + 1` 位足够（0.25 用 2 位、1e-9 用 10 位），多的一位吃掉浮点尾巴
  const places = (() => {
    if (!Number.isFinite(step) || step <= 0) return 6
    const k = Math.floor(Math.log10(step))
    return Math.min(20, Math.max(0, -k + 1))
  })()
  const snap = (v: number) => Number(v.toFixed(places))
  const ticks: number[] = []
  for (let v = low; v <= high + step / 2; v += step) ticks.push(snap(v))
  // 兜底：浮点累加在极小量程上仍可能撞车，最后再按 step/1000 归一次（并去重）
  const uniq = [...new Set(ticks.length ? ticks : [snap(low), snap(high)])]
  return { lo: snap(low), hi: snap(high), ticks: uniq.length ? uniq : [snap(low), snap(high)] }
}

export function clockBeijing(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000)
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`
}

export function monthUsage(node: Node): number {
  if (typeof node.month_used === "number") return node.month_used
  const rx = node.month_rx || 0
  const tx = node.month_tx || 0
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
