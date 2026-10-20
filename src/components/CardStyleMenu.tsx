import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Activity, AlignJustify, Check, Columns2, Grid2x2, LayoutGrid, Rows3, Rows2, Table } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { ThemeConfig } from "@/lib/site-settings"

type CardStyle = ThemeConfig["cardStyle"]

/**
 * 顶栏那枚「卡片形态」菜单：访客自己挑列表用哪一种排法（档位与后台设置一一对应、名字照抄；
 * 站长选了哪档，那一行上会标一枚「默认」）
 *
 * 为什么是"图标 + 菜单"而不是页面上摆一行分段控件：这一行属于**看的人**的偏好，不是内容，
 * 摆进列表工具栏会把列表往下推一行 摆顶栏与地球、明暗开关是同一处，也就同一套规格
 * （36×36、只有图标、说明放 title）
 *
 * 选中的东西不进 hub（那是站长的设置项，见 `@/lib/theme-config` 的 useCardStyle）：
 * 只写访客自己的浏览器
 */
const STYLES: { value: CardStyle; label: string; hint: string; Icon: typeof Grid2x2 }[] = [
  { value: "classic", label: "经典", hint: "速率与总量各一行，底部是 2×2 四格；延迟收在右上角的浮层里", Icon: Grid2x2 },
  { value: "plain", label: "简约", hint: "网络合成一行，标签提亮、进度条更细，不含延迟", Icon: Rows3 },
  { value: "latency", label: "延迟", hint: "网络一行，下方带三网延迟", Icon: Activity },
  { value: "detailed", label: "详细", hint: "在延迟之上再加在线时长、价格与到期", Icon: AlignJustify },
  { value: "detailedNoLatency", label: "详细·无延迟", hint: "与详细相同，但不含三网延迟", Icon: Rows2 },
  { value: "wide", label: "宽卡", hint: "横向大卡，六块版式、不含延迟，列数随容器自适应", Icon: Columns2 },
  { value: "compact", label: "紧凑", hint: "一行一台的表格，密度最高", Icon: Table },
]

export function CardStyleMenu({ value, siteDefault, onPick }: {
  /** 现在生效的那一档 */
  value: CardStyle
  /** 站长在「主题设置」里设的那一档：它那一行标「默认」，也是访客回到"跟着站长走"的那一项 */
  siteDefault: CardStyle
  onPick: (next: CardStyle) => void
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const menu = useRef<HTMLSpanElement>(null)
  // 浮层的落点（宿主 + 坐标），开着的时候才非空；见下面 useLayoutEffect 那段注释
  const [spot, setSpot] = useState<{ host: HTMLElement; top: number; right: number } | null>(null)

  // ★ 浮层**不能**长在按钮里：按钮住在顶栏那条 `overflow-x-auto` 的图标带里，越界的子元素
  //   会被裁掉，点开后菜单几乎整个被裁没，看着就是「点了没反应」所以浮层经 portal 挂到
  //   header 上：header 是 sticky（本身就是绝对定位的锚点），这条路径不经过任何裁剪
  //   坐标照按钮的实时矩形算，条带横向滑动 / 窗口缩放时要重新摆（滑动会让按钮动）
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const b = box.current?.getBoundingClientRect()
      const host = box.current?.closest<HTMLElement>("header")
      const h = host?.getBoundingClientRect()
      if (b && host && h) setSpot({ host, top: b.bottom - h.top + 4, right: h.right - b.right })
    }
    place()
    const strip = box.current?.closest<HTMLElement>(".header-tools")
    window.addEventListener("resize", place)
    strip?.addEventListener("scroll", place)
    return () => {
      window.removeEventListener("resize", place)
      strip?.removeEventListener("scroll", place)
    }
  }, [open])

  // 点别处、按 Esc 都要收起 浮层挂在 header 上（不在 box 里）—— 判「浮层外」要多看它自己
  // 一眼，否则按下选项那一下会先把浮层卸掉、click 就丢了
  // 别写 `e.target as Node` —— 本仓库的 `Node` 是节点类型（@/lib/api），会跟 DOM 的撞名
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const el = e.target
      if (!(el instanceof globalThis.Node) || !(box.current?.contains(el) || menu.current?.contains(el))) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <span className="relative inline-flex" ref={box}>
      <Button
        variant="ghost"
        size="icon"
        className="card-style-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="卡片形态"
        title="卡片形态"
        onClick={() => setOpen((v) => !v)}
      >
        <LayoutGrid />
      </Button>
      {open && spot && createPortal(
        <span
          ref={menu}
          role="menu"
          aria-label="卡片形态"
          data-style-menu=""
          // 绝对定位挂在 header 上；right 贴住按钮右缘（窄屏也不会出界），top 落在按钮下沿 4px
          style={{ top: spot.top, right: spot.right }}
          className="absolute z-20 block w-36 overflow-hidden rounded-md border bg-popover py-1 text-sm shadow-md"
        >
          {STYLES.map(({ value: v, label, hint, Icon }) => (
            <button
              key={v}
              type="button"
              role="menuitemradio"
              aria-checked={v === value}
              data-style-option={v}
              title={hint}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-accent"
              onClick={() => {
                onPick(v)
                setOpen(false)
              }}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{label}</span>
              {v === siteDefault && <span className="shrink-0 text-[10px] text-muted-foreground">默认</span>}
              {v === value && <Check className="size-3.5 shrink-0" />}
            </button>
          ))}
        </span>,
        spot.host,
      )}
    </span>
  )
}
