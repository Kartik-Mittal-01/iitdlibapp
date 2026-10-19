const { AuditLog } = require('../models')
const publisher = require('../realtime/publisher')

const SECRET_KEY_PATTERN = /pass(word)?|token|secret|key|credential|carduid|authorization|hash/i

function redact(value, depth = 0) {
  if (value == null || depth > 4) return value
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (typeof value === 'object' && !(value instanceof Date) && !value._bsontype) {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[redacted]' : redact(v, depth + 1)
    }
    return out
  }
  return value
}

function actorFromPrincipal(principal) {
  if (!principal) return { actorType: 'system', actorId: null }
  return { actorType: principal.type, actorId: principal.id || null }
}

/**
 * Writes an audit record. Never throws: failing to audit must not turn a
 * committed operation into an error response, but it is reported loudly.
 */
async function record({
  actor,
  action,
  outcome = 'success',
  studentId = null,
  sessionId = null,
  terminalCode = null,
  reason = null,
  details = {}
}) {
  try {
    const entry = await AuditLog.create({
      ...actorFromPrincipal(actor),
      action,
      outcome,
      studentId,
      sessionId,
      terminalCode,
      reason,
      details: redact(details)
    })
    publisher.emitAdminLog(entry.toJSON())
    return entry
  } catch (err) {
    console.error(`[audit] failed to record ${action}:`, err.message)
    return null
  }
}

module.exports = { record, redact }
