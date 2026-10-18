import type { CSSProperties, ComponentType, ReactNode } from "react"

type Props = {
  label: ReactNode
  pct: number | null
  foot: ReactNode
  empty?: ReactNode
  /** 详细档：表名前的图标（lucide 组件）经典与延迟档不传，保持纯文字 */
  icon?: ComponentType<{ className?: string; style?: CSSProperties }>
  /**
   * 简约档的读数窗：表名改用前景色（只有附加说明留在弱化灰里），进度条压到 4px、
   * 上下各留 6px，底注降到 11px 三处一起动才是那一档的观感——只把条调细、表名仍是灰的，
   * 整块看着像没对齐的旧版 经典 / 延迟 / 详细三档不传，保持原样
   */
  plain?: boolean
}

/**
 * 一枚指标：上行是名称与百分比，中间是进度条，底下是原始读数单色——条的长度本身就是信息
 *
 * 详细档也照旧：只是在表名前多一枚图标，颜色仍与其余两档同一套灰——图标随所在的
 * 弱化灰文字走 currentColor，不另上色
 *
 * ★ 填色是**前景色的 70%**，不是纯前景色：纯前景色与正文字色相同，是卡片上最重的一笔，
 * 一页 4×N 根条排下来会把读数与标签都压住 70% 明显轻于正文，又远高于图形判读的下限
 * （WCAG 非文本 3:1），低百分比的短条也还认得出来 判据在 tools/verify_card_styles.mjs
 */
export function Meter({ label, pct, foot, empty = "—", icon: Icon, plain = false }: Props) {
  // null 表示这项指标没有可填的上限：条留空而不是报 0% 百分比位置显示什么取决于原因——
  // 没有指标的节点显示 unknown，没有限额的套餐显示 ∞
  const filled = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className={`flex min-w-0 items-center gap-1.5 text-xs${plain ? "" : " text-muted-foreground"}`}>
          {Icon && <Icon className="size-3 shrink-0" />}
          <span className="truncate">{label}</span>
        </span>
        <span className="tnum text-xs font-medium">
          {pct === null ? empty : `${filled < 10 ? filled.toFixed(1) : filled.toFixed(0)}%`}
        </span>
      </div>
      <div className={`w-full overflow-hidden rounded-full bg-muted ${plain ? "my-1.5 h-1" : "mt-1.5 h-1.5"}`}>
        <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-500" style={{ width: `${filled}%` }} />
      </div>
      <div className={`tnum truncate text-muted-foreground ${plain ? "text-[11px]" : "mt-1.5 text-xs"}`}>{foot}</div>
    </div>
  )
}
