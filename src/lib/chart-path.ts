export type PlotPoint = { x: number; y: number }

type LineOptions = { connectGaps?: boolean; smooth?: boolean }

const coordinate = (point: PlotPoint) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`
const finite = (point: PlotPoint) => Number.isFinite(point.x) && Number.isFinite(point.y)
const clamp = (value: number, a: number, b: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), value))

/** 只在严格递增且差值可计算的时间区间内求导，其余相邻点仍可用直线呈现 */
function safeInterval(a: PlotPoint, b: PlotPoint): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return dx > 0 && Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dy / dx)
}

/** 中心差分斜率：y2 相对 y1 在真实 x 间隔上的坡度；溢出或非递增时退 0，不产生 NaN 控制点 */
function safeSlope(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  if (!(dx > 0) || !Number.isFinite(dx)) return 0
  const dy = y2 - y1
  if (!Number.isFinite(dy)) return 0
  const slope = dy / dx
  return Number.isFinite(slope) ? slope : 0
}

/** 返回同一递增片段的后续命令；第一点已经由调用方的 M 或 L 写入
 *  切线用中心差分（Catmull-Rom 风格），曲线整体流动、不再只在拐弯处圆角；
 *  控制点 y 仍夹回相邻样本范围，避免过冲制造假峰或负延迟 */
function smoothSegments(points: PlotPoint[]): string {
  if (points.length < 2) return ""
  if (points.length === 2) return `L${coordinate(points[1])}`
  let path = ""
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const dx = b.x - a.x
    if (!(dx > 0) || !Number.isFinite(dx)) {
      path += `L${coordinate(b)}`
      continue
    }
    const p0 = points[i - 1] ?? a
    const p3 = points[i + 2] ?? b
    const k1 = safeSlope(p0.x, p0.y, b.x, b.y)
    const k2 = safeSlope(a.x, a.y, p3.x, p3.y)
    const first = { x: a.x + dx / 3, y: clamp(a.y + (k1 * dx) / 3, a.y, b.y) }
    const second = { x: b.x - dx / 3, y: clamp(b.y - (k2 * dx) / 3, a.y, b.y) }
    path += `C${coordinate(first)} ${coordinate(second)} ${coordinate(b)}`
  }
  return path
}

function runPath(points: PlotPoint[], smooth: boolean): string {
  if (!points.length) return ""
  let path = `M${coordinate(points[0])}`
  if (!smooth) return path + points.slice(1).map((point) => `L${coordinate(point)}`).join("")
  let start = 0
  while (start < points.length - 1) {
    let end = start
    while (end + 1 < points.length && safeInterval(points[end], points[end + 1])) end++
    path += smoothSegments(points.slice(start, end + 1))
    if (end === points.length - 1) break
    // 重复、逆序或溢出的 x 间隔不参与切线计算，保留采样顺序并退回直线
    path += `L${coordinate(points[end + 1])}`
    start = end + 1
  }
  return path
}

/** 只生成 SVG 路径，不插补、排序或修改样本；默认 null 断段，两个选项互相独立 */
export function linePath(points: Array<PlotPoint | null>, options: LineOptions = {}): string {
  let path = ""
  let run: PlotPoint[] = []
  const flush = () => {
    path += runPath(run, options.smooth === true)
    run = []
  }
  for (const point of points) {
    if (point === null) {
      if (!options.connectGaps) flush()
    } else if (finite(point)) {
      run.push(point)
    } else {
      // 非有限坐标无法绘制，断段，避免把损坏的坐标序列送入 SVG
      flush()
    }
  }
  flush()
  return path
}
