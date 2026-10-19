const { Server } = require('socket.io')
const authService = require('../services/authService')
const publisher = require('./publisher')
const { ROOMS } = publisher
const { SOCKET_EVENTS } = require('../shared')

const EVENT_LIMIT = 20 // per socket
const EVENT_WINDOW_MS = 10 * 1000

function rateLimited(socket) {
  const now = Date.now()
  const bucket = socket.data.rate || { start: now, count: 0 }
  if (now - bucket.start > EVENT_WINDOW_MS) {
    bucket.start = now
    bucket.count = 0
  }
  bucket.count += 1
  socket.data.rate = bucket
  return bucket.count > EVENT_LIMIT
}

function reply(ack, body) {
  if (typeof ack === 'function') ack(body)
}

function fail(ack, code, message) {
  reply(ack, { ok: false, error: { code, message } })
}

/**
 * Socket.IO server. Clients authenticate in the handshake with
 *   io(url, { auth: { token } })
 * using a student, staff or terminal token. Rooms are joined only through the
 * subscribe events below, each authorised against the token's principal.
 */
function initSocket(httpServer, { corsOrigin }) {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin },
    maxHttpBufferSize: 16 * 1024
  })

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token
      if (typeof token !== 'string' || !token) throw new Error('UNAUTHENTICATED')
      const p = await authService.resolveToken(token)
      socket.data.principal = {
        type: p.type,
        id: p.id,
        role: p.role,
        terminalCode: p.terminalCode,
        exp: p.exp
      }
      next()
    } catch (err) {
      const e = new Error(err.code || 'UNAUTHENTICATED')
      e.data = { code: err.code || 'UNAUTHENTICATED' }
      next(e)
    }
  })

  io.on('connection', (socket) => {
    const p = socket.data.principal
    // A student's own session updates go to a private room.
    if (p.type === 'student') socket.join(ROOMS.student(p.id))

    // Disconnect when the token expires so a stale socket does not keep receiving data.
    const msLeft = p.exp * 1000 - Date.now()
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, msLeft))
    socket.on('disconnect', () => clearTimeout(expiryTimer))

    socket.on(SOCKET_EVENTS.MAP_SUBSCRIBE, (_payload, ack) => {
      if (rateLimited(socket)) return fail(ack, 'RATE_LIMITED')
      socket.join(ROOMS.MAP)
      reply(ack, { ok: true, serverTime: new Date().toISOString() })
    })

    socket.on(SOCKET_EVENTS.GATE_SUBSCRIBE, (payload, ack) => {
      if (rateLimited(socket)) return fail(ack, 'RATE_LIMITED')
      if (p.type !== 'terminal') return fail(ack, 'FORBIDDEN', 'Only gate terminals may subscribe.')
      const requested =
        payload && typeof payload.terminalCode === 'string' ? payload.terminalCode : null
      if (requested && requested.toUpperCase() !== p.terminalCode) {
        return fail(ack, 'FORBIDDEN', 'A terminal may only subscribe to its own gate.')
      }
      socket.join(ROOMS.terminal(p.terminalCode))
      reply(ack, { ok: true, terminalCode: p.terminalCode })
    })

    socket.on(SOCKET_EVENTS.ADMIN_SUBSCRIBE, (_payload, ack) => {
      if (rateLimited(socket)) return fail(ack, 'RATE_LIMITED')
      if (p.type !== 'staff') return fail(ack, 'FORBIDDEN')
      socket.join(ROOMS.ADMIN)
      reply(ack, { ok: true })
    })
  })

  publisher.setIo(io)
  return io
}

module.exports = { initSocket }
