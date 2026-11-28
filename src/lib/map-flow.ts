import { VIEW, wrapLon, type Camera, type GlobeNode, type GlobeView, type Pt } from "./globe.ts"

type Point = { x: number; y: number }
type FlowPoint = Pick<GlobeNode, "key" | "id" | "count" | "offlineCount"> & { px: number; py: number }
type Vector = [number, number, number]
type FlowPath = {
  key: string
  d: string
  active: boolean
  delay: number
  front?: string
  back?: string
}
type PreparedGlobeFlow = Pick<FlowPath, "key" | "active" | "delay"> & { samples: Vector[] }
const GLOBE_FLOW_LIFT = 0.34
const xy = ({ x, y }: Point) => `${x.toFixed(2)} ${y.toFixed(2)}`

/** 给最高空间弧预留上下留白；放大时按基准半径封顶，否则画布跟着半径长会抵消缩放 */
export function globeFlowView(view: GlobeView): GlobeView {
  const margin = Math.min(view.r, VIEW.r) * GLOBE_FLOW_LIFT
  return { ...view, cy: view.cy + margin, h: view.h + margin * 2 }
}

function unit([lon, lat]: [number, number]): Vector {
  const a = lon * Math.PI / 180
  const b = lat * Math.PI / 180
  return [Math.cos(b) * Math.sin(a), Math.sin(b), Math.cos(b) * Math.cos(a)]
}

export function globeFlowPoint(cam: Camera, location: [number, number]): Pt {
  return cam.flat(...unit(location))
}

/** 沿最短经度方向在两端纬度之间连接，再径向抬升；旋转帧只做相机投影 */
export function prepareGlobeFlows(points: GlobeNode[], center: Pick<GlobeNode, "key" | "ll">, centerOnline: boolean): PreparedGlobeFlow[] {
  const end = unit(center.ll)
  return points.flatMap((point) => {
    if (point.key === center.key) return []
    const start = unit(point.ll)
    const dot = Math.max(-1, Math.min(1, start.reduce((sum, value, i) => sum + value * end[i], 0)))
    const angle = Math.acos(dot)
    if (angle < 1e-8) return []
    const longitude = wrapLon(center.ll[0] - point.ll[0])
    const latitude = center.ll[1] - point.ll[1]
    const lift = 0.12 + (GLOBE_FLOW_LIFT - 0.12) * angle / Math.PI
    const samples = Array.from({ length: 65 }, (_, index): Vector => {
      const t = index / 64
      const radius = 1 + lift * Math.sin(Math.PI * t)
      const position = unit([point.ll[0] + longitude * t, point.ll[1] + latitude * t])
      return position.map((value) => radius * value) as Vector
    })
    return [{ key: point.key, active: centerOnline && point.offlineCount < point.count, delay: -(point.id % 13) * 0.24, samples }]
  })
}

function occluded(point: Pt, view: GlobeView): boolean {
  return point.k < -1e-8 && Math.hypot(point.x - view.cx, point.y - view.cy) < view.r
}

function splitDepth(samples: Pt[], view: GlobeView) {
  const parts = ["", ""]
  let previous = samples[0]
  let side = Number(occluded(previous, view))
  parts[side] = `M ${xy(previous)}`
  for (const point of samples.slice(1)) {
    const nextSide = Number(occluded(point, view))
    if (side !== nextSide) {
      let low = 0
      let high = 1
      const at = (t: number) => ({ x: previous.x + (point.x - previous.x) * t, y: previous.y + (point.y - previous.y) * t, k: previous.k + (point.k - previous.k) * t })
      for (let i = 0; i < 18; i++) {
        const middle = (low + high) / 2
        if (Number(occluded(at(middle), view)) === side) low = middle
        else high = middle
      }
      const crossing = xy(at((low + high) / 2))
      parts[side] += ` L ${crossing}`
      parts[nextSide] += ` M ${crossing}`
    }
    parts[nextSide] += ` L ${xy(point)}`
    previous = point
    side = nextSide
  }
  return { front: parts[0].trim(), back: parts[1].trim() }
}

/** 包含背面端点的完整路线；按球体遮挡切分实线与透视虚线 */
export function globeFlowPaths(flows: PreparedGlobeFlow[], cam: Camera): FlowPath[] {
  return flows.map(({ samples, ...flow }) => {
    const projected = samples.map((point) => cam.flat(...point))
    return {
      ...flow,
      d: projected.map((point, i) => `${i ? "L" : "M"} ${xy(point)}`).join(" "),
      ...splitDepth(projected, cam.view),
    }
  })
}

function arcControl(start: Point, end: Point) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  return {
    x: (start.x + end.x) / 2 + (length - Math.abs(dx)) * 0.18,
    y: Math.max(0, (start.y + end.y) / 2 - length * 0.37),
  }
}

/** 每个地点只连接一次，直接复用信标和中心在主地图上的坐标 */
export function mapFlowPaths(points: FlowPoint[], center: Pick<FlowPoint, "key" | "px" | "py">, centerOnline: boolean, scale: number): FlowPath[] {
  const end = { x: center.px, y: center.py }
  return points.flatMap((point) => {
    if (point.key === center.key) return []
    const start = { x: point.px, y: point.py }
    const length = Math.hypot(start.x - end.x, start.y - end.y)
    if (!Number.isFinite(length) || length < 2 * scale) return []
    const control = arcControl(start, end)
    return [{
      key: point.key,
      d: `M ${xy(start)} Q ${xy(control)} ${xy(end)}`,
      active: centerOnline && point.offlineCount < point.count,
      delay: -(point.id % 13) * 0.24,
    }]
  })
}
