import { useEffect, useMemo, useState } from 'react'
import { SOCKET_EVENTS } from '../libraryStates.mjs'
import { createApi } from './api'
import { connectSocket } from './socket'

// Caches the terminal token issued via the main process; force=true fetches a new one.
function createTokenProvider({ onError, onTerminal }) {
  let token = null
  return async (force = false) => {
    if (!force && token) return token
    const res = await window.api.getTerminalToken(force)
    if (!res.ok) {
      token = null
      onError(res.error)
      return null
    }
    token = res.token
    onError(null)
    onTerminal(res.terminal)
    return token
  }
}

/**
 * Gate-kiosk connection: obtains a terminal token from the Electron main
 * process (which holds the device key), and exposes an API client and a socket
 * subscribed to this terminal's gate room.
 */
export function useTerminal() {
  const [config, setConfig] = useState(null)
  const [terminal, setTerminal] = useState(null)
  const [authError, setAuthError] = useState(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.getConfig().then((c) => !cancelled && setConfig(c))
    return () => {
      cancelled = true
    }
  }, [])

  const getToken = useMemo(
    () => createTokenProvider({ onError: setAuthError, onTerminal: setTerminal }),
    []
  )

  const configured = Boolean(config?.terminalConfigured)
  const baseUrl = config?.apiBaseUrl

  const api = useMemo(() => {
    if (!configured) return null
    return createApi({
      baseUrl,
      getToken: () => getToken(false),
      onUnauthorized: async () => Boolean(await getToken(true))
    })
  }, [configured, baseUrl, getToken])

  // A fresh token is requested on every (re)connect so an expired one is never reused.
  const socket = useMemo(
    () => (configured ? connectSocket(baseUrl, () => getToken(true)) : null),
    [configured, baseUrl, getToken]
  )

  useEffect(() => {
    if (!socket) return undefined
    const onConnect = () => {
      setConnected(true)
      socket.emit(SOCKET_EVENTS.GATE_SUBSCRIBE, {}, () => {})
    }
    const onDisconnect = () => setConnected(false)
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onDisconnect)
    socket.connect()
    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onDisconnect)
      socket.disconnect()
    }
  }, [socket])

  return { config, terminal, authError, api, socket, connected }
}
