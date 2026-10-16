import { useEffect, useState } from 'react'
import { errorText, type Loaded } from '../api/client'

export interface LoadState<T> {
  loading: boolean
  value: Loaded<T> | null
  error: string | null
}

/**
 * Runs `fn` whenever `deps` change; drops results from stale calls. `fn` returning null means
 * "nothing to load" (e.g. no event selected yet).
 */
export function useLoad<T>(fn: (signal: AbortSignal) => Promise<Loaded<T>> | null, deps: unknown[]): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ loading: false, value: null, error: null })
  useEffect(() => {
    const ctl = new AbortController()
    const p = fn(ctl.signal)
    if (!p) {
      setState({ loading: false, value: null, error: null })
      return
    }
    setState(s => ({ ...s, loading: true, error: null }))
    p.then(
      value => { if (!ctl.signal.aborted) setState({ loading: false, value, error: null }) },
      e => { if (!ctl.signal.aborted) setState({ loading: false, value: null, error: errorText(e) || null }) },
    )
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}
