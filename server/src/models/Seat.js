const mongoose = require('mongoose')
const { SEAT_STATUS } = require('../shared')

// One document per physical seat. Separate documents (rather than seats
// embedded in the table) let a single conditional findOneAndUpdate on
// { _id, status: 'available' } claim a seat atomically without contending on
// the whole table document.
const seatSchema = new mongoose.Schema(
  {
    seatCode: { type: String, required: true, trim: true, uppercase: true },
    tableId: { type: mongoose.Schema.Types.ObjectId, ref: 'LibraryTable', required: true },
    // 1..table.capacity. Unique per table, so a table can never have more seats than its capacity.
    seatNumber: { type: Number, required: true, min: 1 },
    position: {
      x: { type: Number, required: true },
      y: { type: Number, required: true }
    },
    status: { type: String, enum: Object.values(SEAT_STATUS), default: SEAT_STATUS.AVAILABLE },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'LibrarySession', default: null },
    reservedUntil: { type: Date, default: null },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
)

seatSchema.index({ seatCode: 1 }, { unique: true })
seatSchema.index({ tableId: 1, seatNumber: 1 }, { unique: true })
seatSchema.index({ tableId: 1, status: 1 })
// A session can hold at most one seat, and a student at most one seat.
seatSchema.index(
  { sessionId: 1 },
  { unique: true, partialFilterExpression: { sessionId: { $type: 'objectId' } } }
)
seatSchema.index(
  { studentId: 1 },
  { unique: true, partialFilterExpression: { studentId: { $type: 'objectId' } } }
)

seatSchema.set('toJSON', { versionKey: false })

module.exports = mongoose.models.Seat || mongoose.model('Seat', seatSchema)
