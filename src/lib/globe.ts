/**
 * 节点地球的全部几何：正射投影、海岸线取点、经纬网、节点落点与标签排布
 * 从上游移植，输出与它逐点一致；差别只在实现手段：点先落成单位球面向量、每帧只算一组
 * 基向量（省掉每点每帧的三角函数），边缘裁剪在向量上做球面插值
 * 不变量：极角超过阈值（`LIMB_K`）的点不画，背面的点直接丢、跨过边缘的线段裁到边缘上
 */
import { CITY_HINTS, COUNTRY_CITY_FALLBACK, COUNTRY_LL, COUNTRY_NAMES, type Ring } from "./world.ts"
import type { Node } from "@/lib/api"

/** 画布与圆盘 上游 SVG 的 `viewBox="0 0 460 240"` 就是这几个数，改它们等于换一套构图 */
export const VIEW = { w: 460, h: 240, cx: 230, cy: 112, r: 92 } as const
export type GlobeView = Readonly<{ w: number; h: number; cx: number; cy: number; r: number }>
export const GLOBE_ZOOM = { min: 50, max: 150, step: 5, default: 100 } as const

/** 缩放投影半径，保留文字大小；给完整圆盘、密集标签与底部说明留出空间 */
export function zoomView(percent: number, labelCount = 0): GlobeView {
  const zoom = Number.isFinite(percent) ? Math.max(GLOBE_ZOOM.min, Math.min(GLOBE_ZOOM.max, percent)) : GLOBE_ZOOM.default
  const r = VIEW.r * zoom / 100
  // 左右数量差最多 2；用全部落点预留空间，避免自转过程中可见数量变化导致高度跳动
  const rows = Math.ceil(Math.max(0, Number.isFinite(labelCount) ? labelCount : 0) / 2) + 1
  const gap = rows > 14 ? 11 : 13
  const h = Math.max(VIEW.h, r * 2 + 56, 12 + (rows - 1) * gap + 36)
  return { w: VIEW.w, h, cx: VIEW.cx, cy: (h - 16) / 2, r }
}

/** 极角余弦的可见阈值：`cos c > 0.02` 才画（≈ 中心 88.9° 以内，多留一点余量好裁边） */
const LIMB_K = 0.02

export type Quality = "low" | "medium" | "high"

/**
 * 一个精度档的取法 `high` 目前没人用；窄屏自动走 `low`，其余走 `medium`
 * `sweepCount` 是扫掠经线数量（`low` 不画）；`linkMode` 0 = 不画节点连线，1/2 抽样密度递增
 */
export type Profile = {
  key: Quality
  land: "coarse" | "detailed"
  gridLon: number
  gridLat: number
  curveStep: number
  sweepCount: number
  linkMode: 0 | 1 | 2
  idleMs: number
}

export function globeProfile(value: unknown): Profile {
  const q = String(value ?? "medium").trim().toLowerCase()
  if (q === "low") return { key: "low", land: "coarse", gridLon: 60, gridLat: 30, curveStep: 8, sweepCount: 0, linkMode: 0, idleMs: 90 }
  if (q === "high") return { key: "high", land: "detailed", gridLon: 30, gridLat: 30, curveStep: 4, sweepCount: 4, linkMode: 2, idleMs: 48 }
  return { key: "medium", land: "detailed", gridLon: 30, gridLat: 30, curveStep: 7, sweepCount: 1, linkMode: 1, idleMs: 64 }
}

/** 把经度折回 [-180, 180)：拖拽转圈转多少圈都行 写成单层取模，避免浮点误差逐帧累积 */
export function wrapLon(lon: number): number {
  return lon - 360 * Math.floor((lon + 180) / 360)
}

export function clampLat(lat: number): number {
  // ±78°：再往上北极点会贴着圆心转、大陆糊成一团
  return Math.max(-78, Math.min(78, lat))
}

export type Pt = { x: number; y: number; k: number }

/**
 * 一帧的相机：以 (lon0, lat0) 为球面中心做正射投影
 *
 * 基向量（推导：球面点 u = (cosφ·sinλ, sinφ, cosφ·cosλ)，λ₀/φ₀ 为中心经/纬度）
 *   右  e_x = ( cosλ₀, 0, −sinλ₀)                 → u·e_x = cosφ·sin(λ−λ₀)
 *   上  e_y = (−sinφ₀·sinλ₀, cosφ₀, −sinφ₀·cosλ₀) → u·e_y = cosφ₀·sinφ − sinφ₀·cosφ·cos(λ−λ₀)
 *   朝观察者 e_z = ( cosφ₀·sinλ₀, sinφ₀, cosφ₀·cosλ₀) → u·e_z = cos c（可见性判据）
 * 屏幕 y 向下，所以 y = cy − r·(u·e_y)
 */
export type Camera = {
  /** 这一帧的圆盘（圆心与半径）：收口时要贴着它走 */
  view: GlobeView
  /** 单个经纬度 网格线与标签用它 */
  at(lon: number, lat: number): Pt | null
  /** 预计算好的单位向量（岸线用它，省掉每点每帧的三角函数） */
  vec(x: number, y: number, z: number): Pt | null
  /** 从可见点朝背面的点走，落在圆盘边缘上的那一点；给岸线裁边用 */
  limb(from: number[], to: number[]): Pt | null
  /**
   * **正交投影，不看可见性**：背面点的投影方向照样指出「它该落在地平线的哪个方位角上」，
   * 收口时就是靠这个把背面的那一串顶点贴到边缘上
   */
  flat(x: number, y: number, z: number): Pt
  /** 把投影点沿半径拉到地平线上（方位角不变） */
  edge(p: Pt): Pt
  /**
   * 地平线上从 a 到 b 的中间点（按方位角插值，`stepDeg` 是最大步长）
   *
   * `fromAz`/`toAz` 给定时用它俩当起止方位角（收口那条弧要**按顶点顺序展开**的角，
   * 不是两点各自的方位角，见 `landPaths`）；不给就按 a、b 自己算（取近路）
   */
  arc(a: Pt, b: Pt, stepDeg?: number, fromAz?: number, toAz?: number): Pt[]
  /** 屏幕点在球面上的经纬度（正交投影的逆解）收口判「弧在陆地里面还是外面」用 */
  lonLat(p: Pt): [number, number]
}

export function camera(lon0: number, lat0: number, view: GlobeView = VIEW): Camera {
  const a = (lon0 * Math.PI) / 180
  const b = (lat0 * Math.PI) / 180
  const sa = Math.sin(a)
  const ca = Math.cos(a)
  const sb = Math.sin(b)
  const cb = Math.cos(b)
  const ex = [ca, 0, -sa]
  const ey = [-sb * sa, cb, -sb * ca]
  const ez = [cb * sa, sb, cb * ca]

  const vec = (x: number, y: number, z: number): Pt | null => {
    const k = x * ez[0] + y * ez[1] + z * ez[2]
    if (k <= LIMB_K) return null
    return { x: view.cx + view.r * (x * ex[0] + y * ex[1] + z * ex[2]), y: view.cy - view.r * (x * ey[0] + y * ey[1] + z * ey[2]), k }
  }

  /** 正交投影：不做 k 的可见性判断（背面点也要它的方位角） */
  const flat = (x: number, y: number, z: number): Pt => ({
    x: view.cx + view.r * (x * ex[0] + y * ex[1] + z * ex[2]),
    y: view.cy - view.r * (x * ey[0] + y * ey[1] + z * ey[2]),
    k: x * ez[0] + y * ez[1] + z * ez[2],
  })

  /** 方位角（「y 向上」的坐标系，屏幕 y 要翻回来） */
  const azimuth = (p: Pt) => Math.atan2(view.cy - p.y, p.x - view.cx)

  const onEdge = (t: number): Pt => ({ x: view.cx + view.r * Math.cos(t), y: view.cy - view.r * Math.sin(t), k: 0 })

  const arc = (a: Pt, b: Pt, stepDeg = 10, fromAz?: number, toAz?: number): Pt[] => {
    const A = fromAz ?? azimuth(a)
    const B = toAz ?? azimuth(b)
    let d = B - A
    // 调用方给了明确的起止方位角时**不许再折回近路**：收口那条弧可能故意要走远路
    // （跨过 180° 才落在陆地里面），折回就会画到另一边去
    if (fromAz === undefined || toAz === undefined) {
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
    }
    const steps = Math.max(1, Math.ceil(Math.abs(d) / ((stepDeg * Math.PI) / 180)))
    const out: Pt[] = []
    for (let i = 1; i < steps; i += 1) out.push(onEdge(A + (d * i) / steps))
    return out
  }

  return {
    view,
    vec,
    flat,
    edge: (p: Pt) => onEdge(azimuth(p)),
    arc,
    /**
     * 屏幕点（在球面上）的经纬度 —— 收口时判断「这条弧落在陆地里面还是外面」要用它
     * 圆盘内的点用正交投影的逆解；地平线上的点（k=0）解出来的就是那个方位的球面点
     */
    lonLat(p) {
      const u = (p.x - view.cx) / view.r
      const v = (view.cy - p.y) / view.r
      const k2 = Math.max(0, 1 - u * u - v * v)
      const k = Math.sqrt(k2)
      const x = u * ex[0] + v * ey[0] + k * ez[0]
      const y = u * ex[1] + v * ey[1] + k * ez[1]
      const z = u * ex[2] + v * ey[2] + k * ez[2]
      return [(Math.atan2(x, z) * 180) / Math.PI, (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI]
    },
    at(lon, lat) {
      const l = (lon * Math.PI) / 180
      const p = (lat * Math.PI) / 180
      const cp = Math.cos(p)
      return vec(cp * Math.sin(l), Math.sin(p), cp * Math.cos(l))
    },
    limb(from, to) {
      // 在单位向量上二分：可见端 lo、背面端 hi，七次之后落点已在边缘上（上游同为七次）
      let lo = 0
      let hi = 1
      let best: Pt | null = null
      for (let i = 0; i < 7; i += 1) {
        const t = (lo + hi) / 2
        const x = from[0] + (to[0] - from[0]) * t
        const y = from[1] + (to[1] - from[1]) * t
        const z = from[2] + (to[2] - from[2]) * t
        const n = Math.hypot(x, y, z) || 1
        const p = vec(x / n, y / n, z / n)
        if (p) {
          lo = t
          best = p
        } else hi = t
      }
      return best
    },
  }
}

/**
 * 岸线的预计算形式：所有点先落成单位向量，摊在一个 Float64Array 里
 * （`vec[3i], vec[3i+1], vec[3i+2]`），环与环之间用 `offsets` 分隔
 * 抽稀在这里做掉，于是每帧只读不算
 */
export type Prepared = { vec: Float64Array; offsets: Int32Array; rings: Ring[] }

/**
 * ★这里不做抽稀：这套岸线本身已经很稀疏（79 环、1483 点，平均 0.3°/点），再砍会抹掉真实
 * 形状真要省成本该换更粗的岸线数据，而不是在这套上做减法
 */
export function prepareRings(rings: Ring[]): Prepared {
  const kept: Ring[] = []
  let total = 0
  for (const raw of rings) {
    if (!raw || raw.length < 3) continue
    kept.push(raw)
    total += raw.length
  }
  const vec = new Float64Array(total * 3)
  const offsets = new Int32Array(kept.length + 1)
  let w = 0
  kept.forEach((ring, r) => {
    offsets[r] = w
    for (const [lon, lat] of ring) {
      const l = (lon * Math.PI) / 180
      const p = (lat * Math.PI) / 180
      const cp = Math.cos(p)
      vec[w * 3] = cp * Math.sin(l)
      vec[w * 3 + 1] = Math.sin(p)
      vec[w * 3 + 2] = cp * Math.cos(l)
      w += 1
    }
  })
  offsets[kept.length] = w
  return { vec, offsets, rings: kept }
}

/** SVG 路径要的小数位：一位小数，和上游一样（半像素以内，够圆滑也够短） */
const f1 = (n: number) => n.toFixed(1)

/**
 * 收口策略默认 `limb`：从段尾沿地平线走回段首、方向取「弧落在陆地里面」的那一边
 * `walk` 是旧做法，只留给反向自测（`GLOBE_CLOSE=walk`）
 */
const CLOSE_MODE: "limb" | "walk" = (() => {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } }
  return g.process?.env?.GLOBE_CLOSE === "walk" ? "walk" : "limb"
})()

/**
 * 一次投影出全部海岸线，返回给 `<path d>` 的两份串：`fill` 每段闭合（填充要）、
 * `stroke` 不闭合（描边要）
 *
 * 状态机：连着可见的点连成一段；可见→背面补一个边缘点并收段；背面→可见从边缘点另起一段
 * 同一环在圆盘边缘会被切成好几段 —— 这是「背面大陆不会翻到正面」的原因
 *
 * ★收段不能直线 `Z` 一拉了事：段两头都在地平线上，直线收口等于把弦画进圆盘，弦与圆弧
 * 之间那一牙陆地会丢；绕到对面再露头的大环那条弦更会横穿整个圆盘正确做法是沿地平线
 * 圆弧收口，方向由「弧上采样点落在陆地里的比例」定（见 `closeByLimb`）
 */
export function landPaths(cam: Camera, prep: Prepared): { fill: string; stroke: string } {
  const { vec, offsets, rings } = prep
  const view = cam.view
  const fill: string[] = []
  const stroke: string[] = []
  const vis: (Pt | null)[] = []
  const flat: Pt[] = []
  for (let r = 0; r + 1 < offsets.length; r += 1) {
    const from = offsets[r]
    const n = offsets[r + 1] - from
    if (n < 3) continue
    const ring = rings[r] ?? []
    for (let i = 0; i < n; i += 1) {
      const o = (from + i) * 3
      vis[i] = cam.vec(vec[o], vec[o + 1], vec[o + 2])
      flat[i] = cam.flat(vec[o], vec[o + 1], vec[o + 2])
    }
    /**
     * ★从背面第一个顶点开始遍历这一环：这样环的可见部分永远是**一整段连续折线**，
     * 不会因为跨过 index 0（接缝）被切成两段、逼着收尾拉直线
     */
    let firstBack = -1
    for (let i = 0; i < n; i += 1) {
      if (!vis[i]) {
        firstBack = i
        break
      }
    }
    const order: number[] = []
    for (let k = 0; k < n; k += 1) order.push(firstBack > 0 ? (firstBack + k) % n : k)
    const coast: string[] = []
    const shaped: string[] = []
    let cur: string[] = []
    let tail = -1 // 当前段最后一个可见顶点下标
    let drawing = false
    /** 当前段最后一个点的坐标：收口时那条沿地平线的弧要从它起步（见下） */
    let last: Pt | null = null
    /** 当前段的**段首**：收口要沿地平线回到它 */
    let segStart: Pt | null = null
    const start = (p: Pt) => {
      cur.push(`M ${f1(p.x)} ${f1(p.y)}`)
      drawing = true
      last = p
      segStart = p
    }
    /** 地平线上某个方位角上的点 */
    const onEdgeAz = (az: number): Pt => ({ x: view.cx + view.r * Math.cos(az), y: view.cy - view.r * Math.sin(az), k: 0 })
    /** 点是不是贴在地平线上（收口能用「沿边缘走」的前提） */
    const onLimb = (p: Pt | null) => !!p && Math.hypot(p.x - view.cx, p.y - view.cy) > view.r * 0.97
    /** 这一环在经纬度上的内点判定（射线法，与逐像素对账用的真值同一套） */
    const insideRing = (lon: number, lat: number) => {
      let c = false
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]
        const [xj, yj] = ring[j]
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c
      }
      return c
    }
    /**
     * ★★收口：从段尾**沿地平线走回段首**，方向取「这条弧落在陆地里面」的那一边
     * （圆盘边缘上陆地与海的分界就在几条弧之间交替）：两个方向各采样几个点、用射线法
     * 数落在陆地里的比例，谁多走谁
     */
    const closeByLimb = (): string[] => {
      const a = segStart as Pt
      const b = last as Pt
      const azA = Math.atan2(view.cy - a.y, a.x - view.cx)
      const azB = Math.atan2(view.cy - b.y, b.x - view.cx)
      let d = azB - azA
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      const score = (dd: number) => {
        let s = 0
        for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          const [lon, lat] = cam.lonLat(onEdgeAz(azA + dd * t))
          if (insideRing(lon, lat)) s += 1
        }
        return s
      }
      const dLong = d > 0 ? d - Math.PI * 2 : d + Math.PI * 2
      const sShort = score(d), sLong = score(dLong)
      // ★远路（>180°）要**赢得很明显**才走：短弧和远弧都可能是「贴着陆地那一侧」，
      //   采样本身有噪声；判据是「远弧 5 点里 ≥4 点落在陆地、且比短弧多 ≥2」，打平按短弧
      const use = sLong >= 4 && sLong >= sShort + 2 ? dLong : d
      const out: string[] = []
      for (const mid of cam.arc(b, a, 8, azB, azB - use)) out.push(`L ${f1(mid.x)} ${f1(mid.y)}`)
      return out
    }
    /** 收段 `open` = 两头都在地平线上 —— 这时要沿边缘收，不能拉直线 */
    const flush = (open: boolean) => {
      if (!cur.length) return
      const d = cur.join(" ")
      coast.push(d)
      if (!open) {
        shaped.push(`${d} Z`)
        cur = []
        segStart = null
        return
      }
      // ★两头都在地平线上时，收口沿边缘走回段首（方向按「弧落在陆地里面」选，见 closeByLimb）
      //   GLOBE_CLOSE=walk 可以切回旧做法，用来做反向自测
      if (CLOSE_MODE !== "walk" && onLimb(segStart) && onLimb(last)) {
        const back = closeByLimb()
        shaped.push(`${d}${back.length ? " " + back.join(" ") : ""} Z`)
        cur = []
        segStart = null
        return
      }
      // ↓兜底路径：段首/段尾不在地平线上（交点算不出来）或 GLOBE_CLOSE=walk 时才走
      //   ★走到**下一个可见顶点**就停 —— 走到「段首」会把段尾之后所有可见顶点也贴到
      //   地平线上绕圆盘一整圈，整块圆盘被填成陆地
      const back: string[] = []
      let k = (tail + 1) % n
      let guard = 0
      /**
       * ★收口沿地平线走，方向**按这一环的顶点顺序展开**（unwrap）：背面顶点的方位角在
       * 「正对反极点」一带不稳定，所以累加相邻两次的角差得到连续走向，再从段尾沿它
       * 一步步插值回下一个可见顶点 —— 这条边永远贴着地平线走
       */
      let prev: Pt | null = last
      let prevAz = last ? Math.atan2(view.cy - last.y, last.x - view.cx) : null
      while (guard < n && !vis[k]) {
        guard += 1
        const raw = flat[k]
        // 投影半径太小的点（正对观察者反极点那一带）方位角没有意义，跳过
        if (Math.hypot(raw.x - view.cx, raw.y - view.cy) > view.r * 0.06) {
          const p = cam.edge(raw)
          const az = Math.atan2(view.cy - p.y, p.x - view.cx)
          if (prev && prevAz !== null) {
            let d = az - prevAz
            while (d > Math.PI) d -= Math.PI * 2
            while (d < -Math.PI) d += Math.PI * 2
            const target = prevAz + d
            for (const mid of cam.arc(prev, p, 10, prevAz, target)) back.push(`L ${f1(mid.x)} ${f1(mid.y)}`)
            prevAz = target
          }
          back.push(`L ${f1(p.x)} ${f1(p.y)}`)
          prev = p
        }
        k = (k + 1) % n
      }
      shaped.push(`${d}${back.length ? " " + back.join(" ") : ""} Z`)
      cur = []
      segStart = null
    }
    for (let step = 0; step < n; step += 1) {
      const i = order[step]
      const j = order[(step + 1) % n]
      const a = vis[i]
      const b = vis[j]
      const av = [vec[(from + i) * 3], vec[(from + i) * 3 + 1], vec[(from + i) * 3 + 2]]
      const bv = [vec[(from + j) * 3], vec[(from + j) * 3 + 1], vec[(from + j) * 3 + 2]]
      if (a && b) {
        if (!drawing) start(a)
        cur.push(`L ${f1(b.x)} ${f1(b.y)}`)
        last = b
        tail = j
      } else if (a && !b) {
        const c = cam.limb(av, bv)
        if (!drawing) start(a)
        if (c) {
          cur.push(`L ${f1(c.x)} ${f1(c.y)}`)
          last = c
        }
        tail = i
        flush(true)
        drawing = false
      } else if (!a && b) {
        const c = cam.limb(bv, av)
        if (!drawing) start(c ?? b)
        cur.push(`L ${f1(b.x)} ${f1(b.y)}`)
        last = b
        tail = j
      }
    }
    if (drawing) flush(false)
    if (coast.length) {
      stroke.push(coast.join(" "))
      fill.push(shaped.join(" "))
    }
  }
  return { fill: fill.join(" "), stroke: stroke.join(" ") }
}

/**
 * 一条经纬线 经线给 `lon`、纬线给 `lat`（另一维为 `null`），落不到圆盘上的点直接断段
 * 返回空串表示这条线整条都在背面，不必画
 */
export function curvePath(cam: Camera, axis: { lon: number | null; lat: number | null }, from: number, to: number, step: number): string {
  const out: string[] = []
  let drawing = false
  for (let a = from; a <= to; a += step) {
    const p = axis.lon !== null ? cam.at(axis.lon, a) : cam.at(a, axis.lat as number)
    if (!p) {
      drawing = false
      continue
    }
    out.push(`${drawing ? "L" : "M"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    drawing = true
  }
  return out.join(" ")
}

export type Wire = { d: string; width: number; sweep: number }

/**
 * 经纬网：每 `gridLon` 一条经线、每 `gridLat` 一条纬线，赤道加粗一点
 * `sweepLon` 是那条动起来的扫掠经线（`null` = 这个档不画扫掠）
 */
export function graticule(cam: Camera, profile: Profile, sweepLon: number | null): Wire[] {
  const out: Wire[] = []
  for (let lon = -180; lon < 180; lon += profile.gridLon) {
    const d = curvePath(cam, { lon, lat: null }, -80, 80, profile.curveStep)
    if (d) out.push({ d, width: 0.9, sweep: -1 })
  }
  for (let lat = -60; lat <= 60; lat += profile.gridLat) {
    const d = curvePath(cam, { lon: null, lat }, -180, 180, profile.curveStep)
    if (d) out.push({ d, width: 0.9, sweep: -1 })
  }
  const equator = curvePath(cam, { lon: null, lat: 0 }, -180, 180, Math.max(3, profile.curveStep - 1))
  if (equator) out.push({ d: equator, width: 1.15, sweep: -1 })
  if (sweepLon !== null) {
    // 上游那条会动的经线：主道粗一点、后面每 8° 跟着更淡更细的几条
    for (let k = 0; k < profile.sweepCount; k += 1) {
      const d = curvePath(cam, { lon: wrapLon(sweepLon - k * 8), lat: null }, -80, 80, Math.max(3, profile.curveStep - 1))
      if (d) out.push({ d, width: k === 0 ? 1.6 : 1.1, sweep: k })
    }
  }
  return out
}

/** 扫掠经线的透明度：亮色底上要更实一点，越靠后越淡（上游同一套数） */
export function sweepOpacity(dark: boolean, k: number): number {
  return (dark ? 0.42 : 0.52) - k * 0.06
}

/** 扫掠当前的经度 28ms 一度：一圈约 10 秒，慢到不抢眼 */
export function sweepLonAt(now: number): number {
  return wrapLon(((now / 28) % 360) - 180)
}

export function globeCaption(lon: number, lat: number, quality: Quality): string {
  const l = Math.round(lon)
  const b = Math.round(lat)
  return `ORTHOGRAPHIC · ${Math.abs(l)}°${l >= 0 ? "E" : "W"} ${Math.abs(b)}°${b >= 0 ? "N" : "S"} · ${quality.toUpperCase()}`
}

/* ------------------------------------------------------------------ 节点落点 */

/**
 * 标签宽度估法（等宽字体下一个半角 5.05、一个全角 8.6） 只是**兜底**：组件会传真量的
 * `measureText` 进来，量不出来（老浏览器、没有 canvas）才退回这里
 */
export function labelWidth(text: string): number {
  let w = 0
  for (let i = 0; i < text.length; i += 1) w += text.charCodeAt(i) > 255 ? 8.6 : 5.05
  return w + 2
}

/** 保守字宽（上面那份 × 1.18）：用来判"这行字放不放得下"，宁可估宽一点 */
export function inkWidth(text: string): number {
  return labelWidth(text) * 1.18
}

/** 真量一行字有多宽（用户单位） 组件用 canvas 的 `measureText` 实现，纯函数层不认识 DOM */
export type LabelMeasure = (text: string) => number

/** `.globe-label` 是 `stroke-width: 3` + `paint-order: stroke`：墨迹比字宽每边还多 1.5 */
const INK_STROKE = 3

/** 一行标签的墨迹宽度：给了真量函数就用它（更准、也更省字），否则退回估法 */
export function inkWidthWith(measure: LabelMeasure | undefined, text: string): number {
  return measure ? measure(text) + INK_STROKE : inkWidth(text)
}

/** 把一段文字截到放得下为止，多出来的用 `…` 只在**窄屏**上会用到（溢出会被 SVG 视口直接裁掉） */
export function trimLabel(text: string, max: number, measure?: LabelMeasure): string {
  if (!Number.isFinite(max) || inkWidthWith(measure, text) <= max) return text
  const chars = [...text]
  let out = ""
  for (const ch of chars) {
    const next = out + ch
    // 留出省略号本身的位置，否则截完反而多出一点、又被裁
    if (inkWidthWith(measure, `${next}…`) > max) break
    out = next
  }
  return `${out.trimEnd()}…`
}

/** 节点名优先于分组；城市/地区线索只在 hub 声明的国家内匹配 */
export function cityHint(node: Pick<Node, "name" | "group" | "country">): { ll: [number, number]; name: string } | null {
  const code = (node.country || "").trim().toUpperCase()
  for (const value of [node.name, node.group]) {
    if (!value) continue
    // 兼容 Xi’an、Chișinău 与 Kuala_Lumpur-01；不移除数字，避免机场码命中长词/编号
    const text = value.normalize("NFKD").replace(/\p{M}/gu, "").replace(/[’‘ʼ]/g, "'").replace(/[_.–—-]+/g, " ").replace(/\s+/g, " ")
    for (const hint of CITY_HINTS) if (hint.country === code && hint.match.test(text)) return { ll: hint.ll, name: hint.name }
  }
  return null
}

export type Region = {
  /** 地区键（`CC` 或 `CC · 城市名`）：筛选与选中态用它 */
  key: string
  /** ISO 3166-1 alpha-2；空串 = 认不出国家 */
  code: string
  /** 城市/地区英文名（线索没命中时保留历史国家兜底键；两者都没有才是空串） */
  city: string
  /** 地区列表显示城市/地区名；未知城市显示国家/地区全名，不显示裸 ISO 码 */
  label: string
  /** 这一地区的落点（经度, 纬度）：点它时地球飞过去看这里 */
  base: [number, number]
}

/**
 * 一台机器算一个地区 与上游有意的两处不同：
 *   ① hub 给的 ISO 码照实写（HK/TW 不并成 CN）—— 卡片旗子按它取，地球不该另一套说法；
 *   ② 认不出国家的节点直接 `null` —— 不上地球、不占地区列表，下面的列表照旧有它
 * 城名两层来源：名字/分组里的同国线索优先，认不出时保留历史地区键、显示国家全名
 */
export function regionOf(node: Node): Region | null {
  const code = (node.country || "").trim().toUpperCase()
  if (!code) return null
  const hint = cityHint(node)
  const base = hint?.ll ?? COUNTRY_LL[code]
  if (!base) return null
  const city = hint?.name ?? COUNTRY_CITY_FALLBACK[code] ?? ""
  // HK 的已识别/兜底节点共用同一个历史地区键，显示名也保持一致
  const label = hint?.name ?? COUNTRY_NAMES[code] ?? "Unknown region"
  return { key: city ? `${code} · ${city}` : code, code, city, label, base: [base[0], base[1]] }
}

export type GlobeNode = {
  /** 稳定信标键：聚合时为地区键，单台时为节点 ID */
  key: string
  /** 代表节点的稳定命中 ID；聚合信标的具体打开目标由 nodeIds 列表选择 */
  id: number
  /** 这枚针实际代表的节点 ID，按输入节点顺序排列；未合并时只含自身 */
  nodeIds: number[]
  /** 每个真实成员各有一行侧标签，顺序与 nodeIds 一致，名称不替换为聚合地区名 */
  memberLabels: { id: number; name: string; code: string; index: number }[]
  name: string
  code: string
  /** 这个地区里**每一台**都在线才是 true；标记通过 offlineCount 区分全离线与部分离线 */
  online: boolean
  /** 这枚针代表的真实离线台数；单台为 0/1，聚合时逐台统计 */
  offlineCount: number
  /** 在整张图里的序号：连线的抽样要用它（`(a*7+b*3) % divisor`，同上游） */
  index: number
  region: Region
  /** 这个地区有几台（1 台时是普通针，多台时针边挂这个数字） */
  count: number
  /** 针落点（地区中心） */
  ll: [number, number]
}

/** 同地点两台起始终合并；保留原函数签名，整队台数不再影响信标数量 */
export function mergeRegion(_total: number, count: number): boolean {
  return count > 1
}

/**
 * 每个地区落点只留一枚针，成员保留各自名称和输入顺序，不人为挪动地理落点
 * 未识别城市的国家兜底可能与已有城市坐标仅差 0.01°：同国且两轴差 ≤0.05°时，
 * 只与唯一的已识别地区合并，以兜底为显示落点；多个候选则保持独立，避免串联不同城市
 * 这个显示归一化不修改 regionOf / regionRows，也不把未知节点认作某个城市
 */
export function globeNodes(nodes: Node[]): GlobeNode[] {
  const placed: GlobeNode[] = []
  type Member = { node: Node; index: number; region: Region; knownCity: boolean }
  const byRegion = new Map<string, { region: Region; members: Member[] }>()
  nodes.forEach((node, index) => {
    const region = regionOf(node)
    if (!region) return
    const knownCity = cityHint(node) !== null
    const bucket = byRegion.get(region.key) ?? { region, members: [] }
    bucket.members.push({ node, index, region, knownCity })
    // 历史 HK 等地区键可以同时含已识别与兜底成员；兜底坐标作为稳定显示锚点
    if (!knownCity) bucket.region = region
    byRegion.set(region.key, bucket)
  })
  for (const [key, bucket] of byRegion) {
    if (!bucket.members.some((member) => !member.knownCity)) continue
    const candidates = [...byRegion].filter(([otherKey, other]) =>
      otherKey !== key && other.region.code === bucket.region.code && other.members.every((member) => member.knownCity)
      && Math.abs(wrapLon(other.region.base[0] - bucket.region.base[0])) <= 0.05
      && Math.abs(other.region.base[1] - bucket.region.base[1]) <= 0.05,
    )
    if (candidates.length !== 1) continue
    const [otherKey, other] = candidates[0]
    bucket.members.push(...other.members)
    bucket.members.sort((a, b) => a.index - b.index)
    byRegion.delete(otherKey)
  }
  for (const { region, members: bucket } of byRegion.values()) {
    const memberLabels = bucket.map(({ node, index }) => ({ id: node.id, name: node.name, code: region.code, index }))
    if (mergeRegion(nodes.length, bucket.length)) {
      const offlineCount = bucket.reduce((count, { node }) => count + (node.online ? 0 : 1), 0)
      const head = bucket[0]
      placed.push({
        key: region.key,
        id: head.node.id,
        nodeIds: bucket.map(({ node }) => node.id),
        memberLabels,
        name: `${region.label} ×${bucket.length}`,
        code: region.code,
        // 部分离线也保留异常状态，不能被多数在线盖过去
        online: offlineCount === 0,
        offlineCount,
        index: head.index,
        region,
        count: bucket.length,
        ll: [region.base[0], region.base[1]],
      })
      continue
    }
    bucket.forEach(({ node, index }) => {
      placed.push({
        key: String(node.id),
        id: node.id,
        nodeIds: [node.id],
        memberLabels,
        name: node.name,
        code: region.code,
        online: node.online,
        offlineCount: node.online ? 0 : 1,
        index,
        region,
        count: 1,
        ll: [region.base[0], region.base[1]],
      })
    })
  }
  // 顺序回到节点原本的顺序：连线的抽样按 index 来，跟上游一致
  return placed.sort((a, b) => a.index - b.index)
}

/** 地区列表的一行 `offline` 是这一地区里离线的台数（行上那枚小点与悬停文案用它） */
export type RegionRow = { region: Region; count: number; aim: [number, number]; offline: number }
export function regionRows(nodes: Node[]): RegionRow[] {
  const map = new Map<string, RegionRow>()
  for (const node of nodes) {
    const region = regionOf(node)
    if (!region) continue
    const row = map.get(region.key)
    if (row) {
      row.count += 1
      if (!node.online) row.offline += 1
    } else map.set(region.key, { region, count: 1, aim: region.base, offline: node.online ? 0 : 1 })
  }
  return [...map.values()].sort((a, b) => b.count - a.count || (a.region.key < b.region.key ? -1 : a.region.key > b.region.key ? 1 : 0))
}

/**
 * 选中地区的筛选：选中的地区已经不在了（节点下线/改名/换了分组）就回落「全部」，
 * 而不是停在一个什么都看不见的筛选上 —— 与 `groupView` 同一套归一化思路
 */
export function regionView(nodes: Node[], current: string | null) {
  const rows = regionRows(nodes)
  const valid = current !== null && rows.some((row) => row.region.key === current) ? current : null
  return { rows, current: valid, shown: valid === null ? nodes : nodes.filter((node) => regionOf(node)?.key === valid), total: nodes.length }
}

/* ------------------------------------------------------------------ 标签排布 */

export type PlacedLabel = {
  key: string
  id: number
  name: string
  code: string
  index: number
  px: number
  py: number
  lx: number
  ly: number
  end: boolean
  /** 最终显示的那一行（按落到的左右侧从下面两个里取） */
  label: string
  /** 两个方向各自的那一行（左侧写「名字 · 国家」、右侧写「国家 · 名字」） */
  left: string
  right: string
  width: number
}

export type Placed = GlobeNode & {
  px: number
  py: number
  labels: PlacedLabel[]
  /** 兼容单标签调用方；这些布局字段始终取 labels 的第一行 */
  lx: number
  ly: number
  end: boolean
  label: string
  left: string
  right: string
  width: number
}

/**
 * 标签排布：每枚针的每个成员各连到左右两摞里的一行字上，信标与命中区域仍只出一份
 * ① 投影，投影不到的（在背面）不要；② 左右分流，中心附近 ±18 按上一帧的选择留在原侧；
 * ③ 两侧数量差超过 2 就把离中心最近的挪到对面；④ 每摞按 y 排序等距铺开、整摞居中
 * `sides` 是跨帧记忆（信标键 → 左/右），由调用方持有；`maxWidth` 超出的字用 `…` 截掉
 */
export function layoutLabels(cam: Pick<Camera, "view" | "at">, points: GlobeNode[], sides: Map<string, "L" | "R">, maxWidth = Infinity, cx: number = cam.view.cx, measure?: LabelMeasure): Placed[] {
  const visible: { point: GlobeNode; px: number; py: number; labels: PlacedLabel[] }[] = []
  for (const point of points) {
    const p = cam.at(point.ll[0], point.ll[1])
    if (!p) continue
    const labels = point.memberLabels.map((member) => {
      const left = trimLabel(`${member.name} · ${member.code}`, maxWidth, measure)
      const right = trimLabel(`${member.code} · ${member.name}`, maxWidth, measure)
      return {
        ...member, key: `${point.key}:${member.id}`, px: p.x, py: p.y, lx: 0, ly: 0, end: false, label: right,
        width: Math.max(inkWidthWith(measure, left), inkWidthWith(measure, right)), left, right,
      }
    })
    if (labels.length) visible.push({ point, px: p.x, py: p.y, labels })
  }
  const items = visible.flatMap((item) => item.labels)
  const left: PlacedLabel[] = []
  const right: PlacedLabel[] = []
  for (const item of items) {
    let side = item.px >= cx ? "R" : "L"
    const remembered = sides.get(item.key)
    if (remembered && Math.abs(item.px - cx) < 18) side = remembered
    ;(side === "L" ? left : right).push(item)
  }
  const rebalance = (from: PlacedLabel[], to: PlacedLabel[]) => {
    if (from.length - to.length <= 2) return
    const move = from.slice().sort((a, b) => Math.abs(a.px - cx) - Math.abs(b.px - cx) || a.index - b.index)
    while (from.length - to.length > 2 && move.length) {
      const item = move.shift() as PlacedLabel
      const at = from.indexOf(item)
      if (at < 0) continue
      from.splice(at, 1)
      to.push(item)
    }
  }
  rebalance(right, left)
  rebalance(left, right)
  const stack = (list: PlacedLabel[], x: number, end: boolean) => {
    if (!list.length) return
    list.sort((a, b) => a.py - b.py || a.index - b.index)
    const top = 12
    const bottom = cam.view.h - 36
    // zoomView 按全部成员计高度，通常保留 11/13 行距；错误传入过小画布时仍不越界
    const gap = Math.min(list.length > 14 ? 11 : 13, Math.max(0, bottom - top) / Math.max(1, list.length - 1))
    const mean = list.reduce((sum, item) => sum + item.py, 0) / list.length
    let y0 = mean - ((list.length - 1) * gap) / 2
    if (y0 < top) y0 = top
    const last = y0 + (list.length - 1) * gap
    if (last > bottom) y0 -= last - bottom
    if (y0 < top) y0 = top
    list.forEach((item, i) => {
      item.lx = x
      item.ly = y0 + i * gap
      item.end = end
      item.label = end ? item.left : item.right
      sides.set(item.key, end ? "L" : "R")
    })
  }
  // 两摞与圆盘保持 15 个用户单位间距；100% 时仍是上游的 123 / 337
  const offset = cam.view.r + 15
  stack(left, cx - offset, true)
  stack(right, cx + offset, false)
  return visible.map(({ point, px, py, labels }) => {
    const { lx, ly, end, label, left, right, width } = labels[0]
    return { ...point, px, py, labels, lx, ly, end, label, left, right, width }
  })
}

/**
 * 在线节点之间的连线：跨地区才算一对，再按 `(a·7 + b·3) % divisor === 1` 抽稀 ——
 * 26 台两两相连是 325 条，画出来是一团毛线 `linkMode` 越大越密（上游 1 → 8 抽一、2 → 4 抽一）
 */
export function links(placed: Placed[], mode: 0 | 1 | 2, center: Pick<GlobeView, "cx" | "cy"> = VIEW): { d: string }[] {
  if (!mode) return []
  const online = placed.filter((item) => item.online)
  const out: { d: string }[] = []
  const divisor = mode > 1 ? 4 : 8
  for (let i = 0; i < online.length; i += 1) {
    for (let j = i + 1; j < online.length; j += 1) {
      const a = online[i]
      const b = online[j]
      if (a.region.key === b.region.key) continue
      if ((a.index * 7 + b.index * 3) % divisor !== 1) continue
      // 控制点拉向圆心：直线会横穿地球，弧线才像"从球面上绕过去"
      const mx = (a.px + b.px) / 2
      const my = (a.py + b.py) / 2
      const qx = center.cx + (mx - center.cx) * 0.42
      const qy = center.cy + (my - center.cy) * 0.42
      out.push({ d: `M ${f1(a.px)} ${f1(a.py)} Q ${f1(qx)} ${f1(qy)} ${f1(b.px)} ${f1(b.py)}` })
    }
  }
  return out
}
