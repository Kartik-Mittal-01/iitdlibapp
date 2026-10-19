const mongoose = require('mongoose')

const libraryTableSchema = new mongoose.Schema(
  {
    tableCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      match: /^[A-Z0-9-]{1,20}$/
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    capacity: { type: Number, required: true, min: 1, max: 20 },
    // Rectangle on the floor plan (see MAP_CANVAS in shared/libraryStates.mjs).
    location: {
      x: { type: Number, required: true, min: 0 },
      y: { type: Number, required: true, min: 0 },
      width: { type: Number, required: true, min: 1 },
      height: { type: Number, required: true, min: 1 },
      zone: { type: String, trim: true, maxlength: 60, default: '' }
    },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
)

libraryTableSchema.index({ tableCode: 1 }, { unique: true })

libraryTableSchema.set('toJSON', { versionKey: false })

module.exports = mongoose.models.LibraryTable || mongoose.model('LibraryTable', libraryTableSchema)
