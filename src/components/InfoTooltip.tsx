import { useEffect, useRef, useState, type ReactNode } from "react"
import { Popover, Tooltip } from "radix-ui"

const contentClass = "z-50 block max-w-[18rem] rounded-md border bg-popover px-2.5 py-1.5 text-xs leading-relaxed text-popover-foreground shadow-md"

/**
 * 信息悬浮提示：把原生 `title` 换成自己的浮层（radix Tooltip，Globe 的信标提示同一套）——
 * 样式跟着主题走、出现快，长口径说明能换行，不像系统气泡那样闷成一行
 *
 * `text` 传字符串或任意节点（要排版的提示直接给 JSX，见账单页名称列的机器信息卡）；
 * 没有 text 就只渲染 children——调用方不用写条件分支
 *
 * `clickable` 给纯展示的触发元素用：鼠标悬浮照旧，触摸点一下也能开
 * （Radix Tooltip 只响应 hover/focus，触屏没有 hover）
 */
export function InfoTooltip({ text, children, clickable = false }: { text?: ReactNode; children: ReactNode; clickable?: boolean }) {
  if (!text) return <>{children}</>
  if (clickable) return <ClickInfo text={text}>{children}</ClickInfo>
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="top" sideOffset={6} collisionPadding={8} className={contentClass}>
          {text}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

function ClickInfo({ text, children }: { text: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  // 触屏点开与鼠标悬浮要分开记：滚动关闭只对触屏生效，桌面悬浮照旧
  const source = useRef<"mouse" | "touch">("touch")
  useEffect(() => {
    if (!open || source.current !== "touch") return
    const close = () => setOpen(false)
    document.addEventListener("scroll", close, true)
    return () => document.removeEventListener("scroll", close, true)
  }, [open])
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild
        onPointerDown={(event) => { source.current = event.pointerType === "mouse" ? "mouse" : "touch" }}
        onPointerEnter={(event) => { if (event.pointerType === "mouse") { source.current = "mouse"; setOpen(true) } }}
        onPointerLeave={(event) => { if (event.pointerType === "mouse") setOpen(false) }}
      >
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onPointerDownOutside={() => setOpen(false)}
          className={contentClass}
        >
          {text}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}