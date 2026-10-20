import type { ReactNode } from "react"

import { highlightRanges } from "@/lib/search"

/**
 * 搜索命中处描色：把 text 里命中词（字面出现、大小写不敏感）的片段包成 `<mark>`
 *
 * 词为空、或一个字面命中都没有时**原样返回**，不改变任何现有渲染（mark 不改变 textContent）
 * `<mark>` 的浏览器默认样式由 Tailwind preflight 折掉大半，这里显式给一套前景色 20% 浅底 +
 * 前景色文字——深浅两套主题都跟着同一个 token 走，与「命中处提一下、不把卡片变成荧光笔」一致
 */
export function TextHighlight({ text, terms }: { text: string; terms?: string[] }) {
  if (!terms?.length || !text) return <>{text}</>
  const ranges = highlightRanges(text, terms)
  if (!ranges.length) return <>{text}</>
  const out: ReactNode[] = []
  let pos = 0
  ranges.forEach(([from, to], i) => {
    if (from > pos) out.push(text.slice(pos, from))
    out.push(
      <mark key={i} className="rounded-[3px] bg-foreground/20 px-px text-foreground">
        {text.slice(from, to)}
      </mark>,
    )
    pos = to
  })
  if (pos < text.length) out.push(text.slice(pos))
  return <>{out}</>
}