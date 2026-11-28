import { useLayoutEffect, useRef } from "react"

/** 在内容的标识切换后入场，首次挂载和同一内容的实时更新直接绘制 */
export function useContentTransition<T extends HTMLElement>(key: string | null, from = 0.75) {
  const ref = useRef<T>(null)
  const previous = useRef(key)
  useLayoutEffect(() => {
    if (previous.current === key) return
    previous.current = key
    if (!ref.current || matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const fade = ref.current.animate([{ opacity: from }, { opacity: 1 }], { duration: 160, easing: "ease-out" })
    return () => fade.cancel()
  }, [key, from])
  return ref
}
