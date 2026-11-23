const communityService = require('../services/communityService')
const { ok, parsePagination } = require('../utils/http')

function viewerIdOf(req) {
  return req.principal.type === 'student' ? req.principal.id : null
}

async function listPosts(req, res) {
  const { category, q, status, mine } = req.valid.query
  ok(
    res,
    await communityService.listPosts(
      { category, q, status, mine, authorId: req.principal.id, viewerId: viewerIdOf(req) },
      parsePagination(req.valid.query)
    )
  )
}

async function createPost(req, res) {
  const post = await communityService.createPost({ authorId: req.principal.id, ...req.valid.body })
  ok(res, post, 201)
}

async function getPost(req, res) {
  ok(res, await communityService.getPost(req.valid.params.postId, viewerIdOf(req)))
}

async function updatePost(req, res) {
  ok(res, await communityService.updatePost(req.valid.params.postId, req.valid.body, req.principal))
}

async function deletePost(req, res) {
  await communityService.deletePost(req.valid.params.postId, req.principal)
  ok(res, { deleted: true })
}

async function toggleInterest(req, res) {
  ok(res, await communityService.toggleInterest(req.valid.params.postId, req.principal.id))
}

async function listComments(req, res) {
  ok(
    res,
    await communityService.listComments(req.valid.params.postId, parsePagination(req.valid.query))
  )
}

async function addComment(req, res) {
  const comment = await communityService.addComment(
    req.valid.params.postId,
    req.principal.id,
    req.valid.body.body
  )
  ok(res, comment, 201)
}

module.exports = {
  listPosts,
  createPost,
  getPost,
  updatePost,
  deletePost,
  toggleInterest,
  listComments,
  addComment
}
