import type { ReactNode } from "react"
import { Tooltip } from "radix-ui"

/**
 * 信息悬浮提示：把原生 `title` 换成自己的浮层（radix Tooltip，Globe 的信标提示同一套）——
 * 样式跟着主题走、出现快，长口径说明能换行，不像系统气泡那样闷成一行
 *
 * `text` 传字符串或任意节点（要排版的提示直接给 JSX，见账单页名称列的机器信息卡）；
 * 没有 text 就只渲染 children——调用方不用写条件分支
 */
export function InfoTooltip({ text, children }: { text?: ReactNode; children: ReactNode }) {
  if (!text) return <>{children}</>
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="top" sideOffset={6} collisionPadding={8} className="z-50 block max-w-[18rem] rounded-md border bg-popover px-2.5 py-1.5 text-xs leading-relaxed text-popover-foreground shadow-md">
          {text}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
