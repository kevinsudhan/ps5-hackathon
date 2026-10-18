import { useEffect, useRef, useState } from 'react'

/** True when the person asked the system for less motion. */
export function usePrefersReducedMotion() {
  const q = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches)
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const m = matchMedia(q)
    const on = () => setReduced(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return reduced
}

/** Count up to `value` (eased); jumps straight there with reduced motion. */
export function useCountUp(value: number | null | undefined, reduced: boolean, ms = 900) {
  const [shown, setShown] = useState<number | null>(value ?? null)
  const from = useRef(0)
  useEffect(() => {
    if (value == null) { setShown(null); return }
    if (reduced) { setShown(value); from.current = value; return }
    const start = performance.now(), a = from.current
    let raf = 0
    const tick = () => {
      const k = Math.min(1, (performance.now() - start) / ms)
      const v = a + (value - a) * (1 - Math.pow(1 - k, 3))
      setShown(k < 1 ? v : value)
      if (k < 1) raf = requestAnimationFrame(tick)
      else from.current = value
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, reduced, ms])
  return shown
}
