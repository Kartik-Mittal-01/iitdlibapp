const mongoose = require('mongoose')
const { COMMUNITY_CATEGORY_KEYS, COMMUNITY_POST_STATUSES } = require('../shared')

// One student-authored request/offer on the Community board. Kept
// intentionally simple: text only (no attachments), students opt in to
// sharing contactInfo themselves rather than the app exposing a DM system.
const communityPostSchema = new mongoose.Schema(
  {
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    category: { type: String, enum: COMMUNITY_CATEGORY_KEYS, required: true },
    title: { type: String, required: true, trim: true, minlength: 3, maxlength: 140 },
    body: { type: String, required: true, trim: true, minlength: 1, maxlength: 4000 },
    tags: { type: [String], default: [] },
    // Free text the student chooses to publish (email, room, phone...); never required.
    contactInfo: { type: String, trim: true, maxlength: 200, default: '' },
    status: { type: String, enum: COMMUNITY_POST_STATUSES, default: 'open' },
    interestedStudentIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Student' }],
      default: []
    },
    interestedCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    // Staff-only: pinned posts (e.g. library announcements) sort first.
    isPinned: { type: Boolean, default: false }
  },
  { timestamps: true }
)

communityPostSchema.index({ title: 'text', body: 'text', tags: 'text' })
communityPostSchema.index({ isPinned: -1, createdAt: -1 })
communityPostSchema.index({ category: 1, createdAt: -1 })
communityPostSchema.index({ authorId: 1, createdAt: -1 })

communityPostSchema.set('toJSON', { versionKey: false })

module.exports =
  mongoose.models.CommunityPost || mongoose.model('CommunityPost', communityPostSchema)
