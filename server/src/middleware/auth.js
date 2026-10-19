const AppError = require('../utils/AppError')
const authService = require('../services/authService')
const { GateTerminal } = require('../models')

// Records terminal liveness for the admin UI, at most once a minute per terminal.
function touchTerminal(id) {
  const now = new Date()
  GateTerminal.updateOne(
    { _id: id, $or: [{ lastSeenAt: null }, { lastSeenAt: { $lt: new Date(now - 60 * 1000) } }] },
    { $set: { lastSeenAt: now } }
  ).catch(() => {})
}

function bearerToken(req) {
  const header = req.get('authorization') || ''
  const [scheme, token] = header.split(' ')
  return scheme && scheme.toLowerCase() === 'bearer' && token ? token : null
}

/**
 * Requires a valid bearer token for one of the given principal types
 * ('student', 'staff', 'terminal'). Sets req.principal.
 */
function authenticate(...types) {
  return async (req, _res, next) => {
    const token = bearerToken(req)
    if (!token) throw AppError.unauthorized()
    const principal = await authService.resolveToken(token)
    if (types.length && !types.includes(principal.type)) throw AppError.forbidden()
    req.principal = principal
    next()
  }
}

/** Staff role check; use after authenticate('staff'). */
function requireRole(...roles) {
  return (req, _res, next) => {
    if (req.principal?.type !== 'staff' || !roles.includes(req.principal.role)) {
      throw AppError.forbidden()
    }
    next()
  }
}

/**
 * Gate terminals authenticate either with their device key
 * (X-Terminal-Code + X-Terminal-Key headers, used by the ESP32 over HTTPS) or
 * with a short-lived terminal token issued from that key (used by the kiosk).
 */
function authenticateTerminal() {
  return async (req, _res, next) => {
    const code = req.get('x-terminal-code')
    const key = req.get('x-terminal-key')
    if (code && key) {
      const doc = await authService.authenticateTerminalKey(code, key)
      req.principal = {
        type: 'terminal',
        id: String(doc._id),
        doc,
        terminalCode: doc.terminalCode,
        gateType: doc.gateType
      }
      touchTerminal(doc._id)
      return next()
    }
    const token = bearerToken(req)
    if (!token) throw AppError.unauthorized('TERMINAL_UNAUTHORIZED')
    const principal = await authService.resolveToken(token)
    if (principal.type !== 'terminal') throw AppError.forbidden('TERMINAL_UNAUTHORIZED')
    req.principal = principal
    touchTerminal(principal.doc._id)
    next()
  }
}

module.exports = { authenticate, requireRole, authenticateTerminal, bearerToken }
