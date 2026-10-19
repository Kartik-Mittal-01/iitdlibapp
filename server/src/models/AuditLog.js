const mongoose = require('mongoose')

const auditLogSchema = new mongoose.Schema(
  {
    actorType: { type: String, enum: ['student', 'staff', 'terminal', 'system'], required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    action: { type: String, required: true },
    outcome: { type: String, enum: ['success', 'rejected', 'info'], default: 'success' },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', default: null },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'LibrarySession', default: null },
    terminalCode: { type: String, default: null },
    reason: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

auditLogSchema.index({ createdAt: -1 })
auditLogSchema.index({ action: 1, createdAt: -1 })
auditLogSchema.index({ studentId: 1, createdAt: -1 })
auditLogSchema.index({ terminalCode: 1, createdAt: -1 })

auditLogSchema.set('toJSON', { versionKey: false })

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema)
