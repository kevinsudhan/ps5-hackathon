import { useCallback, useEffect, useState } from 'react'

/** Callback ref + live size. Follows the element even if the component swaps which node gets the ref. */
export function useSize<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const ref = useCallback((node: T | null) => setEl(node), [])
  useEffect(() => {
    if (!el) return
    // Measure once right away: ResizeObserver only reports on a painted frame, which a hidden or
    // backgrounded window may not produce for a while.
    const r = el.getBoundingClientRect()
    setSize(s => (s.width === Math.round(r.width) && s.height === Math.round(r.height) ? s : { width: Math.round(r.width), height: Math.round(r.height) }))
    const ro = new ResizeObserver(([e]) => {
      const width = Math.round(e.contentRect.width), height = Math.round(e.contentRect.height)
      setSize(s => (s.width === width && s.height === height ? s : { width, height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [ref, size] as const
}
