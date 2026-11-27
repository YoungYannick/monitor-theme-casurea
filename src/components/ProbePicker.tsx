import { useMemo, useRef, useState } from "react"
import { ChevronDown, Search, X } from "lucide-react"
import { Popover } from "radix-ui"

/** 名称搜索与多选共用分行图的选择状态，搜索不清空已选线路 */
export function ProbePicker({ probes, selected, limit, onToggle, onClear, onAll }: {
  probes: { id: number; name: string }[]
  selected: number[]
  limit: number
  onToggle: (id: number) => void
  onClear: () => void
  onAll: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const input = useRef<HTMLInputElement>(null)
  const needle = query.trim().toLocaleLowerCase()
  const matches = useMemo(() => probes.filter((probe) => probe.name.toLocaleLowerCase().includes(needle)), [probes, needle])
  const chosen = probes.filter((probe) => selected.includes(probe.id))
  return (
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery("") }}>
      <Popover.Trigger asChild>
        <button type="button" data-probe-picker className="tap tap-y-6 ml-auto inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          选择线路<span className="tnum">{selected.length}/{limit}</span><ChevronDown className="size-3" aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content data-probe-picker-panel align="end" sideOffset={6} collisionPadding={12} aria-label="选择对比线路" onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus() }} className="z-50 flex max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2 rounded-lg border bg-popover p-2 text-popover-foreground shadow-md">
          <div className="flex items-center gap-2 rounded-md border px-2 py-1.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input ref={input} type="search" data-probe-search aria-label="搜索线路" placeholder="搜索线路" value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="tnum">已选 {selected.length}/{limit}</span>
            {probes.length > 0 && probes.length <= limit && <button type="button" data-probe-picker-all className="tap tap-y-6 ml-auto hover:text-foreground" onClick={onAll}>{selected.length === probes.length ? "取消全选" : "全选"}</button>}
            {selected.length > 0 && <button type="button" className="tap tap-y-6 ml-auto hover:text-foreground" onClick={onClear}>清除选择</button>}
          </div>
          {chosen.length > 0 && <div className="flex flex-wrap gap-1">
            {chosen.map((probe) => <button key={probe.id} type="button" data-probe-picked={probe.id} aria-label={`移除：${probe.name}`} title={probe.name} onClick={() => onToggle(probe.id)} className="tap tap-y-12 inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px]"><span className="truncate">{probe.name}</span><X className="size-3 shrink-0 text-muted-foreground" aria-hidden /></button>)}
          </div>}
          <div data-probe-options className="max-h-[min(16rem,45dvh)] min-h-0 overflow-y-auto">
            {matches.length > 0 ? matches.map((probe) => {
              const checked = selected.includes(probe.id)
              const disabled = !checked && selected.length >= limit
              return <label key={probe.id} className={`flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-xs hover:bg-muted ${disabled ? "opacity-40" : ""}`}>
                <input type="checkbox" data-probe-option={probe.id} checked={checked} disabled={disabled} onChange={() => onToggle(probe.id)} className="shrink-0 accent-foreground" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{probe.name}</span>
              </label>
            }) : <p className="py-4 text-center text-xs text-muted-foreground">没有匹配的线路</p>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
