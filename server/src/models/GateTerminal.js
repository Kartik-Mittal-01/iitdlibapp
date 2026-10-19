const mongoose = require('mongoose')
const { GATE_TYPES } = require('../shared')

// A registered gate device (ESP32 reader and/or the kiosk app at that gate).
// The gate type always comes from this record, never from the client.
const gateTerminalSchema = new mongoose.Schema(
  {
    terminalCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: /^[A-Z0-9-]{2,40}$/
    },
    gateType: { type: String, enum: Object.values(GATE_TYPES), required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    isActive: { type: Boolean, default: true },
    // SHA-256 of a 256-bit random key (high entropy, so a fast hash is appropriate).
    credentialHash: { type: String, required: true, select: false },
    // Bumped on key rotation; terminal tokens carrying an older version are rejected.
    credentialVersion: { type: Number, default: 1 },
    credentialRotatedAt: { type: Date, default: () => new Date() },
    lastSeenAt: { type: Date, default: null }
  },
  { timestamps: true }
)

gateTerminalSchema.index({ terminalCode: 1 }, { unique: true })

gateTerminalSchema.set('toJSON', {
  versionKey: false,
  transform(_doc, ret) {
    delete ret.credentialHash
    return ret
  }
})

module.exports = mongoose.models.GateTerminal || mongoose.model('GateTerminal', gateTerminalSchema)
