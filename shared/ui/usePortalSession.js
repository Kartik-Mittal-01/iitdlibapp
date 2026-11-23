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

// Same default the Electron main process falls back to (commonapp/src/main/appConfig.js),
// so the plain-web build works out of the box against the deployed backend.
const DEFAULT_API_BASE_URL = 'https://iitd-library-backend.onrender.com'

/**
 * API base URL. In the Electron app this comes from the main process
 * (configurable at runtime without a rebuild, see appConfig.js). The plain-web
 * build has no main process, so it falls back to a Vite build-time env var
 * (VITE_API_BASE_URL) and, failing that, the same production default.
 */
export function useApiBaseUrl() {
  const [baseUrl, setBaseUrl] = useState(null)
  useEffect(() => {
    let cancelled = false
    const resolve = window.api?.getConfig
      ? window.api.getConfig().then((c) => c.apiBaseUrl)
      : Promise.resolve(import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL)
    resolve.then((url) => !cancelled && setBaseUrl(url))
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
