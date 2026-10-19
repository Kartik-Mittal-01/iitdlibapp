import { useCallback, useEffect, useState } from 'react'
import { SOCKET_EVENTS } from '../libraryStates.mjs'
import { useAsync } from './useAsync'

function applySeatUpdates(map, updates) {
  if (!map || !updates?.length) return map
  const byId = new Map(updates.map((s) => [s.id, s]))
  const tables = map.tables.map((t) => {
    if (!t.seats.some((s) => byId.has(s.id))) return t
    const seats = t.seats
      .map((s) => (byId.has(s.id) ? { ...s, ...byId.get(s.id) } : s))
      .filter((s) => s.isActive !== false)
    const counts = { available: 0, occupied: 0, reserved: 0 }
    for (const s of seats) counts[s.status] += 1
    return { ...t, seats, counts }
  })
  return { ...map, tables }
}

/**
 * Loads the floor plan over REST, then applies Socket.IO updates. After every
 * (re)connect the full map is fetched again, so missed events cannot leave the
 * view stale. The server is the source of truth for every seat state.
 */
export function useLibraryMap(api, socket) {
  const fetcher = useCallback(() => (api ? api.get('/api/library/map') : null), [api])
  const { data: map, error, reload, setData } = useAsync(api ? fetcher : null)
  const [connected, setConnected] = useState(socket ? socket.connected : null)

  useEffect(() => {
    if (!socket) return undefined
    const onConnect = () => {
      setConnected(true)
      socket.emit(SOCKET_EVENTS.MAP_SUBSCRIBE, {}, () => {})
      reload()
    }
    const onDisconnect = () => setConnected(false)
    const onMap = (payload) => {
      if (payload?.reload) reload()
      else setData((m) => applySeatUpdates(m, payload?.seats))
    }
    const onOccupancy = (occupancy) => setData((m) => (m ? { ...m, occupancy } : m))

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onDisconnect)
    socket.on(SOCKET_EVENTS.MAP_UPDATED, onMap)
    socket.on(SOCKET_EVENTS.OCCUPANCY_UPDATED, onOccupancy)
    if (socket.connected) socket.emit(SOCKET_EVENTS.MAP_SUBSCRIBE, {}, () => {})
    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onDisconnect)
      socket.off(SOCKET_EVENTS.MAP_UPDATED, onMap)
      socket.off(SOCKET_EVENTS.OCCUPANCY_UPDATED, onOccupancy)
    }
  }, [socket, reload, setData])

  return {
    map,
    occupancy: map?.occupancy || null,
    error,
    connected: socket ? connected : null,
    reload
  }
}
