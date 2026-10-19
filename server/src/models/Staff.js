const mongoose = require('mongoose')

const STAFF_ROLES = ['admin', 'staff']

const staffSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    passwordHash: { type: String, required: true, select: false },
    // admin: full control. staff: library desk (read logs/sessions, issue/revoke cards).
    role: { type: String, enum: STAFF_ROLES, default: 'staff' },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
)

staffSchema.index({ email: 1 }, { unique: true })

staffSchema.set('toJSON', {
  versionKey: false,
  transform(_doc, ret) {
    delete ret.passwordHash
    return ret
  }
})

const Staff = mongoose.models.Staff || mongoose.model('Staff', staffSchema)
module.exports = Staff
module.exports.STAFF_ROLES = STAFF_ROLES
