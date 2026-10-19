const mongoose = require('mongoose')

// Logged-out JWTs (by jti). Each entry is removed by MongoDB once the token
// would have expired anyway.
const revokedTokenSchema = new mongoose.Schema({
  jti: { type: String, required: true },
  expiresAt: { type: Date, required: true }
})

revokedTokenSchema.index({ jti: 1 }, { unique: true })
revokedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

module.exports = mongoose.models.RevokedToken || mongoose.model('RevokedToken', revokedTokenSchema)
