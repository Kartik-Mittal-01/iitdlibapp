const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const h = require('./helpers')

function auth(token) {
  return { Authorization: `Bearer ${token}` }
}

describe('community board', () => {
  before(h.setup)
  after(h.teardown)
  beforeEach(h.resetDb)

  async function createPost(token, overrides = {}) {
    return h.api()
      .post('/api/community/posts')
      .set(auth(token))
      .send({
        category: 'academic_help',
        title: 'Looking for CVL212 notes',
        body: 'Does anyone have notes from last semester?',
        ...overrides
      })
  }

  test('a student can create, list and read back a post', async () => {
    const { token, student } = await h.createStudent()
    const created = await h.must(createPost(token), 201)
    assert.equal(created.body.data.category, 'academic_help')
    assert.equal(created.body.data.author.entryNumber, student.entryNumber)
    assert.equal(created.body.data.status, 'open')
    assert.equal(created.body.data.commentCount, 0)

    const list = await h.must(
      h.api().get('/api/community/posts').set(auth(token)),
      200
    )
    assert.equal(list.body.data.total, 1)
    assert.equal(list.body.data.items[0].title, created.body.data.title)

    const detail = await h.must(
      h.api().get(`/api/community/posts/${created.body.data.id}`).set(auth(token)),
      200
    )
    assert.equal(detail.body.data.title, created.body.data.title)
  })

  test('staff can also list posts; unauthenticated requests are refused', async () => {
    const { token: studentToken } = await h.createStudent()
    await h.must(createPost(studentToken), 201)
    const { token: staffToken } = await h.createStaff('staff')
    const asStaff = await h.must(
      h.api().get('/api/community/posts').set(auth(staffToken)),
      200
    )
    assert.equal(asStaff.body.data.total, 1)

    const noAuth = await h.api().get('/api/community/posts')
    assert.equal(noAuth.status, 401)
  })

  test('posts are filtered by category and found by text search', async () => {
    const { token } = await h.createStudent()
    await h.must(createPost(token, { category: 'academic_help', title: 'PYQs for CVL212' }), 201)
    await h.must(
      createPost(token, {
        category: 'collaborate',
        title: 'Need an ML collaborator',
        body: 'Looking for a teammate familiar with PyTorch.'
      }),
      201
    )

    const byCategory = await h.must(
      h.api().get('/api/community/posts').query({ category: 'collaborate' }).set(auth(token)),
      200
    )
    assert.equal(byCategory.body.data.total, 1)
    assert.equal(byCategory.body.data.items[0].category, 'collaborate')

    const bySearch = await h.must(
      h.api().get('/api/community/posts').query({ q: 'PyTorch' }).set(auth(token)),
      200
    )
    assert.equal(bySearch.body.data.total, 1)
    assert.match(bySearch.body.data.items[0].title, /ML collaborator/)
  })

  test('only the author can edit or delete their post; staff can delete any post', async () => {
    const { token: ownerToken } = await h.createStudent()
    const { token: otherToken } = await h.createStudent()
    const { token: staffToken } = await h.createStaff('staff')
    const post = (await h.must(createPost(ownerToken), 201)).body.data

    const forbiddenEdit = await h.api()
      .patch(`/api/community/posts/${post.id}`)
      .set(auth(otherToken))
      .send({ title: 'Hijacked title' })
    assert.equal(forbiddenEdit.status, 403)

    const forbiddenDelete = await h.api()
      .delete(`/api/community/posts/${post.id}`)
      .set(auth(otherToken))
    assert.equal(forbiddenDelete.status, 403)

    const ownEdit = await h.must(
      h.api().patch(`/api/community/posts/${post.id}`).set(auth(ownerToken)).send({ status: 'resolved' }),
      200
    )
    assert.equal(ownEdit.body.data.status, 'resolved')

    const staffDelete = await h.must(
      h.api().delete(`/api/community/posts/${post.id}`).set(auth(staffToken)),
      200
    )
    assert.equal(staffDelete.body.data.deleted, true)
    assert.ok(
      await h.models.AuditLog.exists({ action: 'community.post.removed_by_staff' })
    )
    const gone = await h.api().get(`/api/community/posts/${post.id}`).set(auth(ownerToken))
    assert.equal(gone.status, 404)
  })

  test('interest can be toggled by other students but not by the author', async () => {
    const { token: ownerToken } = await h.createStudent()
    const { token: interestedToken } = await h.createStudent()
    const post = (await h.must(createPost(ownerToken), 201)).body.data

    const own = await h.api().post(`/api/community/posts/${post.id}/interest`).set(auth(ownerToken))
    assert.equal(own.status, 400)
    assert.equal(own.body.error.code, 'OWN_POST_INTEREST')

    const on = await h.must(
      h.api().post(`/api/community/posts/${post.id}/interest`).set(auth(interestedToken)),
      200
    )
    assert.equal(on.body.data.interested, true)
    assert.equal(on.body.data.post.interestedCount, 1)

    const off = await h.must(
      h.api().post(`/api/community/posts/${post.id}/interest`).set(auth(interestedToken)),
      200
    )
    assert.equal(off.body.data.interested, false)
    assert.equal(off.body.data.post.interestedCount, 0)
  })

  test('comments can be added and listed in order, and bump the post comment count', async () => {
    const { token: ownerToken } = await h.createStudent()
    const { token: replierToken } = await h.createStudent()
    const post = (await h.must(createPost(ownerToken), 201)).body.data

    await h.must(
      h.api()
        .post(`/api/community/posts/${post.id}/comments`)
        .set(auth(replierToken))
        .send({ body: 'I have the notes, I can share.' }),
      201
    )
    await h.must(
      h.api()
        .post(`/api/community/posts/${post.id}/comments`)
        .set(auth(ownerToken))
        .send({ body: 'That would be great, thank you!' }),
      201
    )

    const list = await h.must(
      h.api().get(`/api/community/posts/${post.id}/comments`).set(auth(ownerToken)),
      200
    )
    assert.equal(list.body.data.total, 2)
    assert.equal(list.body.data.items[0].body, 'I have the notes, I can share.')

    const updated = await h.api().get(`/api/community/posts/${post.id}`).set(auth(ownerToken))
    assert.equal(updated.body.data.commentCount, 2)
  })

  test('a non-existent post returns POST_NOT_FOUND', async () => {
    const { token } = await h.createStudent()
    const res = await h.api().get(`/api/community/posts/${'0'.repeat(24)}`).set(auth(token))
    assert.equal(res.status, 404)
    assert.equal(res.body.error.code, 'POST_NOT_FOUND')
  })

  test('creating a post is rate-limited per student', async () => {
    const { config } = require('../src/config/env')
    config.rateLimit.enabled = true
    try {
      const { token } = await h.createStudent()
      for (let i = 0; i < config.rateLimit.communityPostMax; i++) {
        await h.must(createPost(token, { title: `Post number ${i}` }), 201)
      }
      const res = await createPost(token, { title: 'One too many' })
      assert.equal(res.status, 429)
      assert.equal(res.body.error.code, 'RATE_LIMITED')
    } finally {
      config.rateLimit.enabled = false
    }
  })
})
