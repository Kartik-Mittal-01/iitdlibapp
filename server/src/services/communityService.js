// Community board: student-authored posts (requests/offers), comments and an
// "I'm interested" response. Text only, no attachments or DMs — students who
// want to be reached publish their own contactInfo. Moderation (delete any
// post) is available to staff; everything else a student does is scoped to
// their own posts, enforced here rather than trusted from the client.

const { CommunityPost, CommunityComment } = require('../models')
const audit = require('./auditService')
const AppError = require('../utils/AppError')
const { paginated } = require('../utils/http')

const AUTHOR_FIELDS = 'name entryNumber'

function staffActor(principal) {
  return principal?.type === 'staff' ? { type: 'staff', id: principal.id } : principal
}

// Public view shapes (never the raw Mongoose document), matching the
// convention used for student-facing data elsewhere (gateService.describe,
// mapService.seatView/tableView): plain objects, string ids.
function studentView(student) {
  if (!student) return null
  return { id: String(student._id), name: student.name, entryNumber: student.entryNumber }
}

function postView(post, viewerId) {
  return {
    id: String(post._id),
    author: studentView(post.authorId),
    category: post.category,
    title: post.title,
    body: post.body,
    tags: post.tags,
    contactInfo: post.contactInfo,
    status: post.status,
    interestedCount: post.interestedCount,
    youAreInterested: viewerId
      ? post.interestedStudentIds.some((id) => String(id) === String(viewerId))
      : false,
    commentCount: post.commentCount,
    isPinned: post.isPinned,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt
  }
}

function commentView(comment) {
  return {
    id: String(comment._id),
    postId: String(comment.postId),
    author: studentView(comment.authorId),
    body: comment.body,
    createdAt: comment.createdAt
  }
}

async function createPost({ authorId, category, title, body, tags, contactInfo }) {
  const post = await CommunityPost.create({
    authorId,
    category,
    title,
    body,
    tags: tags || [],
    contactInfo: contactInfo || ''
  })
  await audit.record({
    actor: { type: 'student', id: authorId },
    action: 'community.post.created',
    studentId: authorId,
    details: { postId: post._id, category }
  })
  await post.populate('authorId', AUTHOR_FIELDS)
  return postView(post, authorId)
}

async function listPosts({ category, q, status, mine, authorId, viewerId }, pg) {
  const filter = {}
  if (category) filter.category = category
  if (status) filter.status = status
  if (mine && authorId) filter.authorId = authorId
  if (q) filter.$text = { $search: q }

  const sort = q ? { score: { $meta: 'textScore' } } : { isPinned: -1, createdAt: -1 }
  const projection = q ? { score: { $meta: 'textScore' } } : undefined

  const [items, total] = await Promise.all([
    CommunityPost.find(filter, projection)
      .sort(sort)
      .skip(pg.skip)
      .limit(pg.limit)
      .populate('authorId', AUTHOR_FIELDS),
    CommunityPost.countDocuments(filter)
  ])
  return paginated(
    items.map((p) => postView(p, viewerId)),
    total,
    pg
  )
}

async function findPostOr404(postId) {
  const post = await CommunityPost.findById(postId).populate('authorId', AUTHOR_FIELDS)
  if (!post) throw AppError.notFound('POST_NOT_FOUND')
  return post
}

async function getPost(postId, viewerId) {
  const post = await findPostOr404(postId)
  return postView(post, viewerId)
}

const STUDENT_EDITABLE_FIELDS = ['title', 'body', 'category', 'tags', 'contactInfo', 'status']
const STAFF_EDITABLE_FIELDS = ['status', 'isPinned']

async function updatePost(postId, changes, principal) {
  const post = await findPostOr404(postId)
  const isStaff = principal.type === 'staff'
  const isAuthor = String(post.authorId._id) === String(principal.id)
  if (!isStaff && !isAuthor) throw AppError.forbidden('NOT_POST_AUTHOR')

  const allowed = isStaff && !isAuthor ? STAFF_EDITABLE_FIELDS : STUDENT_EDITABLE_FIELDS
  for (const key of Object.keys(changes)) {
    if (!allowed.includes(key)) throw AppError.forbidden('NOT_POST_AUTHOR')
    post[key] = changes[key]
  }
  await post.save()
  await audit.record({
    actor: isStaff ? staffActor(principal) : { type: 'student', id: principal.id },
    action: 'community.post.updated',
    studentId: String(post.authorId._id),
    details: { postId: post._id, fields: Object.keys(changes) }
  })
  return postView(post, isStaff ? null : principal.id)
}

async function deletePost(postId, principal) {
  const post = await findPostOr404(postId)
  const isStaff = principal.type === 'staff'
  const isAuthor = String(post.authorId._id) === String(principal.id)
  if (!isStaff && !isAuthor) throw AppError.forbidden('NOT_POST_AUTHOR')

  await CommunityPost.deleteOne({ _id: post._id })
  await CommunityComment.deleteMany({ postId: post._id })
  await audit.record({
    actor: isStaff ? staffActor(principal) : { type: 'student', id: principal.id },
    action: isStaff && !isAuthor ? 'community.post.removed_by_staff' : 'community.post.deleted',
    studentId: String(post.authorId._id),
    details: { postId: post._id, title: post.title }
  })
}

async function toggleInterest(postId, studentId) {
  const post = await findPostOr404(postId)
  if (String(post.authorId._id) === String(studentId)) throw AppError.badRequest('OWN_POST_INTEREST')

  const already = post.interestedStudentIds.some((id) => String(id) === String(studentId))
  const update = already
    ? { $pull: { interestedStudentIds: studentId }, $inc: { interestedCount: -1 } }
    : { $addToSet: { interestedStudentIds: studentId }, $inc: { interestedCount: 1 } }
  const updated = await CommunityPost.findByIdAndUpdate(postId, update, {
    returnDocument: 'after'
  }).populate('authorId', AUTHOR_FIELDS)
  return { interested: !already, post: postView(updated, studentId) }
}

async function listComments(postId, pg) {
  await findPostOr404(postId)
  const filter = { postId }
  const [items, total] = await Promise.all([
    CommunityComment.find(filter)
      .sort({ createdAt: 1 })
      .skip(pg.skip)
      .limit(pg.limit)
      .populate('authorId', AUTHOR_FIELDS),
    CommunityComment.countDocuments(filter)
  ])
  return paginated(items.map(commentView), total, pg)
}

async function addComment(postId, authorId, body) {
  const post = await findPostOr404(postId)
  const comment = await CommunityComment.create({ postId, authorId, body })
  await CommunityPost.updateOne({ _id: post._id }, { $inc: { commentCount: 1 } })
  await audit.record({
    actor: { type: 'student', id: authorId },
    action: 'community.comment.created',
    studentId: authorId,
    details: { postId: post._id, commentId: comment._id }
  })
  await comment.populate('authorId', AUTHOR_FIELDS)
  return commentView(comment)
}

module.exports = {
  createPost,
  listPosts,
  getPost,
  updatePost,
  deletePost,
  toggleInterest,
  listComments,
  addComment
}
