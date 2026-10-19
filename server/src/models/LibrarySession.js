const mongoose = require('mongoose')
const { SESSION_STATUS } = require('../shared')

// One document per admitted library visit.
//
// status:
//   inside    – student was admitted and is currently inside; their seat is occupied.
//   hold      – student left through an exit gate choosing "15-minute hold"; exitTime is
//               set and the seat stays reserved until holdUntil. Re-entering before
//               holdUntil resumes this same session and seat.
//   completed – the visit is over (immediate exit, or the hold expired). The seat has been
//               released; a later entry creates a new session.
//
// isOpen mirrors (status !== 'completed') so a single unique partial index can guarantee
// that a student never has two open visits (two "inside", or "inside" + "hold", or two holds).
const librarySessionSchema = new mongoose.Schema(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    entryTime: { type: Date, required: true },
    exitTime: { type: Date, default: null },
    entryGateId: { type: String, required: true },
    exitGateId: { type: String, default: null },
    status: { type: String, enum: Object.values(SESSION_STATUS), required: true },
    isOpen: { type: Boolean, required: true },
    holdUntil: { type: Date, default: null },
    seatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Seat', default: null },
    tableId: { type: mongoose.Schema.Types.ObjectId, ref: 'LibraryTable', default: null },
    resumeCount: { type: Number, default: 0 },
    lastResumedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    endReason: {
      type: String,
      enum: ['exit', 'hold_expired', 'reconciled', null],
      default: null
    }
  },
  { timestamps: true }
)

librarySessionSchema.pre('validate', function () {
  this.isOpen = this.status !== SESSION_STATUS.COMPLETED
})

// Requested invariant: at most one "inside" session per student.
librarySessionSchema.index(
  { studentId: 1 },
  {
    unique: true,
    name: 'one_inside_session_per_student',
    partialFilterExpression: { status: SESSION_STATUS.INSIDE }
  }
)
// Stronger invariant: at most one open (inside OR hold) session per student, so duplicate
// scans cannot create a second visit or a second hold reservation.
librarySessionSchema.index(
  { studentId: 1, isOpen: 1 },
  {
    unique: true,
    name: 'one_open_session_per_student',
    partialFilterExpression: { isOpen: true }
  }
)
librarySessionSchema.index({ status: 1, holdUntil: 1 })
librarySessionSchema.index({ tableId: 1, status: 1 })
librarySessionSchema.index({ studentId: 1, createdAt: -1 })
librarySessionSchema.index({ createdAt: -1 })

librarySessionSchema.set('toJSON', { versionKey: false })

module.exports =
  mongoose.models.LibrarySession || mongoose.model('LibrarySession', librarySessionSchema)
