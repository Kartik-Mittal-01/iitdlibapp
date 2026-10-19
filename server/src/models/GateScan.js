const mongoose = require('mongoose')

// A card scan accepted at a terminal. The kiosk completes the gate workflow by
// presenting the single-use scan token, so it never has to (and cannot) name a
// student itself.
//
// status:
//   pending    – waiting for the kiosk to submit entry/exit.
//   processing – an entry/exit request holding this token is running.
//   consumed   – workflow completed; `result` is replayed for retried requests.
//   superseded – a newer scan arrived at the same terminal.
//   rejected   – the scan was refused; `result` holds the error for idempotent replays.
const gateScanSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, default: null },
    terminalId: { type: mongoose.Schema.Types.ObjectId, ref: 'GateTerminal', required: true },
    terminalCode: { type: String, required: true },
    gateType: { type: String, required: true },
    // Optional idempotency key from the device (retries of the same physical scan).
    requestId: { type: String, default: null },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
    cardId: { type: mongoose.Schema.Types.ObjectId, ref: 'RFIDCard', default: null },
    status: {
      type: String,
      enum: ['pending', 'processing', 'consumed', 'superseded', 'rejected'],
      required: true
    },
    nextAction: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    httpStatus: { type: Number, default: 200 },
    response: { type: mongoose.Schema.Types.Mixed, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { timestamps: true }
)

gateScanSchema.index(
  { tokenHash: 1 },
  { unique: true, partialFilterExpression: { tokenHash: { $type: 'string' } } }
)
gateScanSchema.index(
  { terminalId: 1, requestId: 1 },
  { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } }
)
gateScanSchema.index({ terminalId: 1, status: 1 })
// Scan records are short-lived operational data; audit logs keep the history.
gateScanSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 })

module.exports = mongoose.models.GateScan || mongoose.model('GateScan', gateScanSchema)
