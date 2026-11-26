import { useEffect, useRef } from "react"

let cancelEndClick: (() => void) | null = null

/** 长按后的兼容点击可能换目标，捕获它；新的手势开始即撤销拦截。 */
function suppressLongPressClick() {
  cancelEndClick?.()
  const clear = () => {
    window.clearTimeout(timer)
    document.removeEventListener("click", absorb, true)
    document.removeEventListener("pointerdown", clear, true)
    if (cancelEndClick === clear) cancelEndClick = null
  }
  const absorb = (event: MouseEvent) => {
    clear()
    if (event.detail === 0) return
    event.preventDefault()
    event.stopPropagation()
  }
  const timer = window.setTimeout(clear, 8_000)
  cancelEndClick = clear
  document.addEventListener("click", absorb, true)
  document.addEventListener("pointerdown", clear, true)
}

/** 单击显隐，双击或触屏长按独看，保持一枚简约图例按钮 */
export function ProbeLegendButton({ id, name, stroke, width, loss, shown, highlighted, onToggle, onSolo, onHighlight, row = false }: {
  id: number
  name: string
  stroke: string
  width?: number
  loss: number
  shown: boolean
  highlighted: boolean
  onToggle: () => void
  onSolo: () => void
  onHighlight: (kind: "hover" | "focus", active: boolean) => void
  row?: boolean
}) {
  const press = useRef<{ timer: number; x: number; y: number } | null>(null)
  const suppressClick = useRef(false)
  const pointerType = useRef("mouse")
  const clearPress = () => {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = null
  }
  useEffect(() => () => {
    if (press.current) window.clearTimeout(press.current.timer)
  }, [])

  return (
    <button
      type="button"
      data-probe-toggle={id}
      aria-pressed={shown}
      title={name}
      onClick={(event) => {
        if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return }
        suppressClick.current = false
        onToggle()
      }}
      onDoubleClick={() => { if (pointerType.current === "mouse") onSolo() }}
      onPointerDown={(e) => {
        clearPress()
        suppressClick.current = false
        pointerType.current = e.pointerType
        if (e.pointerType === "mouse") return
        // 长按结束后的兼容点击仍落在这枚图例，避免落到相邻按钮。
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 指针已结束时忽略 */ }
        press.current = {
          x: e.clientX, y: e.clientY,
          timer: window.setTimeout(() => {
            press.current = null
            suppressClick.current = true
            suppressLongPressClick()
            onSolo()
          }, 500),
        }
      }}
      onPointerMove={(e) => {
        const start = press.current
        if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) clearPress()
      }}
      onPointerUp={() => { if (suppressClick.current) suppressLongPressClick(); clearPress() }}
      onPointerCancel={clearPress}
      onContextMenu={(e) => e.preventDefault()}
      onPointerEnter={(e) => { if (e.pointerType === "mouse") onHighlight("hover", true) }}
      onPointerLeave={() => { clearPress(); onHighlight("hover", false) }}
      onFocus={() => onHighlight("focus", true)}
      onBlur={() => onHighlight("focus", false)}
      className={`tap inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring select-none ${row ? "text-left text-sm font-medium" : "border px-2 py-1 text-xs"} ${
        !row && highlighted ? "border-ring bg-muted" : ""
      } ${row || shown ? "" : "opacity-40"}`}
      style={{ WebkitTouchCallout: "none" }}
    >
      {!row && <svg width="14" height="6" className="shrink-0" aria-hidden>
        <line x1="0" y1="3" x2="14" y2="3" stroke={stroke} strokeWidth={width ?? 2} />
      </svg>}
      <span className="truncate">{name}</span>
      {!row && loss > 0 && (
        <span className="shrink-0 whitespace-nowrap tabular-nums opacity-60">丢 {loss < 1 ? "<1" : Math.round(loss)}%</span>
      )}
    </button>
  )
}
