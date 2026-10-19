const { SOCKET_EVENTS } = require('../shared')

// Holds the Socket.IO server (or a test double). Services never emit directly:
// controllers publish only after the database operation has committed, and the
// payloads are re-read from the database (the source of truth).
let io = null

const ROOMS = {
  MAP: 'map',
  ADMIN: 'admin',
  terminal: (code) => `terminal:${code}`,
  student: (id) => `student:${id}`
}

function setIo(instance) {
  io = instance
}

function emit(room, event, payload) {
  if (!io) return
  io.to(room).emit(event, payload)
}

function emitGateResult(terminalCode, payload) {
  emit(ROOMS.terminal(terminalCode), SOCKET_EVENTS.GATE_RESULT, payload)
}

function emitAdminLog(entry) {
  emit(ROOMS.ADMIN, SOCKET_EVENTS.ADMIN_LOG, entry)
}

/**
 * Broadcast the effects of a committed state change.
 * @param {{ seatIds?: any[], sessionIds?: any[] }} changes
 */
async function publishChanges(changes) {
  if (!io || !changes) return
  // Lazy require avoids a load-order cycle (mapService -> gateService -> publisher).
  const mapService = require('../services/mapService')
  const seatIds = [...new Set((changes.seatIds || []).filter(Boolean).map(String))]
  const sessionIds = [...new Set((changes.sessionIds || []).filter(Boolean).map(String))]
  if (seatIds.length) {
    const seats = await mapService.getSeatStates(seatIds)
    emit(ROOMS.MAP, SOCKET_EVENTS.MAP_UPDATED, { seats, serverTime: new Date().toISOString() })
    emit(ROOMS.ADMIN, SOCKET_EVENTS.MAP_UPDATED, { seats, serverTime: new Date().toISOString() })
    const occupancy = await mapService.getOccupancy()
    emit(ROOMS.MAP, SOCKET_EVENTS.OCCUPANCY_UPDATED, occupancy)
    emit(ROOMS.ADMIN, SOCKET_EVENTS.OCCUPANCY_UPDATED, occupancy)
  }
  if (sessionIds.length) {
    const sessions = await mapService.getSessionSummaries(sessionIds)
    for (const s of sessions) {
      emit(ROOMS.student(s.studentId), SOCKET_EVENTS.SESSION_UPDATED, s)
      emit(ROOMS.ADMIN, SOCKET_EVENTS.SESSION_UPDATED, s)
    }
  }
}

// Layout changed (tables/seats added or removed): clients refetch GET /api/library/map.
function publishMapReload() {
  const payload = { reload: true, serverTime: new Date().toISOString() }
  emit(ROOMS.MAP, SOCKET_EVENTS.MAP_UPDATED, payload)
  emit(ROOMS.ADMIN, SOCKET_EVENTS.MAP_UPDATED, payload)
}

// Fire-and-forget wrapper: a broadcast failure must never fail the request whose
// database change has already committed. Clients re-fetch on reconnect.
function publish(changes) {
  return publishChanges(changes).catch((err) => {
    console.error('[realtime] publish failed:', err.message)
  })
}

module.exports = {
  ROOMS,
  setIo,
  emit,
  emitGateResult,
  emitAdminLog,
  publish,
  publishChanges,
  publishMapReload
}
