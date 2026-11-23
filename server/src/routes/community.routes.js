const { Router } = require('express')
const ctrl = require('../controllers/communityController')
const { authenticate } = require('../middleware/auth')
const { communityPostLimiter } = require('../middleware/rateLimit')
const { validate, z, objectId, boolString, pagination } = require('../middleware/validate')
const { COMMUNITY_CATEGORY_KEYS, COMMUNITY_POST_STATUSES } = require('../shared')

const router = Router()

const anyPrincipal = authenticate('student', 'staff')
const studentOnly = authenticate('student')

const category = z.enum(COMMUNITY_CATEGORY_KEYS)
const status = z.enum(COMMUNITY_POST_STATUSES)

const postBody = z.object({
  category,
  title: z.string().trim().min(3).max(140),
  body: z.string().trim().min(1).max(4000),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  contactInfo: z.string().trim().max(200).optional()
})

const postUpdateBody = z
  .object({
    category: category.optional(),
    title: z.string().trim().min(3).max(140).optional(),
    body: z.string().trim().min(1).max(4000).optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
    contactInfo: z.string().trim().max(200).optional(),
    status: status.optional(),
    isPinned: z.boolean().optional()
  })
  .refine((b) => Object.keys(b).length > 0, 'No changes given.')

const commentBody = z.object({ body: z.string().trim().min(1).max(2000) })

const listQuery = z.object({
  category: category.optional(),
  status: status.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  mine: boolString,
  ...pagination
})

const postIdParams = z.object({ postId: objectId })

router.get('/posts', anyPrincipal, validate({ query: listQuery }), ctrl.listPosts)
router.post(
  '/posts',
  studentOnly,
  communityPostLimiter,
  validate({ body: postBody }),
  ctrl.createPost
)
router.get('/posts/:postId', anyPrincipal, validate({ params: postIdParams }), ctrl.getPost)
router.patch(
  '/posts/:postId',
  anyPrincipal,
  validate({ params: postIdParams, body: postUpdateBody }),
  ctrl.updatePost
)
router.delete('/posts/:postId', anyPrincipal, validate({ params: postIdParams }), ctrl.deletePost)
router.post(
  '/posts/:postId/interest',
  studentOnly,
  validate({ params: postIdParams }),
  ctrl.toggleInterest
)
router.get(
  '/posts/:postId/comments',
  anyPrincipal,
  validate({ params: postIdParams, query: z.object(pagination) }),
  ctrl.listComments
)
router.post(
  '/posts/:postId/comments',
  studentOnly,
  validate({ params: postIdParams, body: commentBody }),
  ctrl.addComment
)

module.exports = router
