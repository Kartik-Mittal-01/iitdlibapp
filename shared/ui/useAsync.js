import { useCallback, useEffect, useState } from 'react'

/**
 * Runs `fetcher` (a memoised async function) whenever it changes or reload()
 * is called, ignoring results that arrive after the inputs changed.
 */
export function useAsync(fetcher) {
  const [state, setState] = useState({ data: null, error: null })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!fetcher) return undefined
    let cancelled = false
    fetcher().then(
      (data) => !cancelled && setState({ data, error: null }),
      (error) => !cancelled && setState((s) => ({ ...s, error }))
    )
    return () => {
      cancelled = true
    }
  }, [fetcher, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const setData = useCallback(
    (update) =>
      setState((s) => ({
        ...s,
        data: typeof update === 'function' ? update(s.data) : update
      })),
    []
  )
  return {
    data: state.data,
    error: state.error,
    loading: !state.data && !state.error,
    reload,
    setData
  }
}
