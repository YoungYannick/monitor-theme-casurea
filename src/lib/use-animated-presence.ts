import { useLayoutEffect, useRef, useState } from "react"

/** 关闭时等元素自己的 CSS 过渡结束再卸载 减少动态效果时直接卸载 */
export function useAnimatedPresence<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null)
  const [retained, setRetained] = useState(open)
  if (open && !retained) setRetained(true)

  useLayoutEffect(() => {
    if (open || !retained) return
    const animations = ref.current?.getAnimations?.() ?? []
    let cancelled = false
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!cancelled) setRetained(false)
    })
    return () => { cancelled = true }
  }, [open, retained])

  return { ref, present: retained }
}
