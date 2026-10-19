import { useCallback, useEffect, useMemo, useState } from 'react'
import { createApi } from './api'
import { connectSocket } from './socket'

function readStored(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key) || 'null')
  } catch {
    return null
  }
}

function writeStored(key, value) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value))
    else sessionStorage.removeItem(key)
  } catch {
    // Storage unavailable: the session simply lasts until the window closes.
  }
}

/** API base URL from the Electron main process (configurable at runtime). */
export function useApiBaseUrl() {
  const [baseUrl, setBaseUrl] = useState(null)
  useEffect(() => {
    let cancelled = false
    window.api.getConfig().then((c) => !cancelled && setBaseUrl(c.apiBaseUrl))
    return () => {
      cancelled = true
    }
  }, [])
  return baseUrl
}

/**
 * Signed-in student or staff session (token kept for this window only).
 * `kind` is 'student' or 'staff'.
 */
export function usePortalSession(kind) {
  const storageKey = `iitdlib.${kind}`
  const baseUrl = useApiBaseUrl()
  const [session, setSession] = useState(() => readStored(storageKey))

  const save = useCallback(
    (value) => {
      writeStored(storageKey, value)
      setSession(value)
    },
    [storageKey]
  )

  const token = session?.token || null
  const api = useMemo(() => {
    if (!baseUrl) return null
    return createApi({
      baseUrl,
      getToken: () => token,
      // An expired or revoked token signs the user out.
      onUnauthorized: async () => {
        if (token) save(null)
        return false
      }
    })
  }, [baseUrl, token, save])

  const socket = useMemo(
    () => (baseUrl && token ? connectSocket(baseUrl, () => token) : null),
    [baseUrl, token]
  )
  useEffect(() => {
    if (!socket) return undefined
    socket.connect()
    return () => socket.disconnect()
  }, [socket])

  const logout = useCallback(async () => {
    const path = kind === 'staff' ? '/api/admin/logout' : '/api/auth/logout'
    try {
      await api?.post(path)
    } catch {
      // Signing out locally is enough if the server cannot be reached.
    }
    save(null)
  }, [api, kind, save])

  return {
    baseUrl,
    api,
    socket,
    session,
    user: session?.user || null,
    save,
    logout
  }
}
