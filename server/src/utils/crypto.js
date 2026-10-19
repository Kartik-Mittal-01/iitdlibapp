const crypto = require('crypto')
const { config } = require('../config/env')

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

// Card UIDs arrive as hex strings from the reader (e.g. "04:A3:1B:22" or "04a31b22").
function normalizeCardUid(uid) {
  return String(uid)
    .replace(/[\s:-]/g, '')
    .toUpperCase()
}

function hashCardUid(uid) {
  return crypto
    .createHmac('sha256', config.cardUidPepper)
    .update(normalizeCardUid(uid))
    .digest('hex')
}

module.exports = { randomToken, sha256, safeEqualHex, normalizeCardUid, hashCardUid }
