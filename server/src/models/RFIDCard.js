const mongoose = require('mongoose')

// The card stores nothing about the student. The reader sends the card UID; the
// server stores only an HMAC of it (CARD_UID_PEPPER), so a database leak does
// not reveal raw UIDs and lost cards are revoked by flipping isActive.
const rfidCardSchema = new mongoose.Schema(
  {
    cardUidHash: { type: String, required: true },
    // Last 4 hex characters, for staff to recognise a card in the admin UI.
    cardUidHint: { type: String, default: '' },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    isActive: { type: Boolean, default: true },
    issuedAt: { type: Date, default: () => new Date() },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null, maxlength: 200 }
  },
  { timestamps: true }
)

rfidCardSchema.index({ cardUidHash: 1 }, { unique: true })
// At most one active card per student.
rfidCardSchema.index(
  { studentId: 1 },
  { unique: true, name: 'one_active_card_per_student', partialFilterExpression: { isActive: true } }
)

rfidCardSchema.set('toJSON', {
  versionKey: false,
  transform(_doc, ret) {
    delete ret.cardUidHash
    return ret
  }
})

module.exports = mongoose.models.RFIDCard || mongoose.model('RFIDCard', rfidCardSchema)
