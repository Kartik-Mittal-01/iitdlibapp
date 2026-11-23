const mongoose = require('mongoose')

const communityCommentSchema = new mongoose.Schema(
  {
    postId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunityPost', required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    body: { type: String, required: true, trim: true, minlength: 1, maxlength: 2000 }
  },
  { timestamps: true }
)

communityCommentSchema.index({ postId: 1, createdAt: 1 })

communityCommentSchema.set('toJSON', { versionKey: false })

module.exports =
  mongoose.models.CommunityComment || mongoose.model('CommunityComment', communityCommentSchema)
