const mongoose = require('mongoose')

const studentSchema = new mongoose.Schema(
  {
    // IIT Delhi entry number, e.g. 2021CS10123. Stored upper-case.
    entryNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: /^[A-Z0-9]{6,15}$/
    },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    passwordHash: { type: String, required: true, select: false },
    department: { type: String, required: true, trim: true, maxlength: 120 },
    programme: { type: String, required: true, trim: true, maxlength: 120 },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
)

studentSchema.index({ entryNumber: 1 }, { unique: true })
studentSchema.index({ email: 1 }, { unique: true })

studentSchema.set('toJSON', {
  versionKey: false,
  transform(_doc, ret) {
    delete ret.passwordHash
    return ret
  }
})

module.exports = mongoose.models.Student || mongoose.model('Student', studentSchema)
