const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const h = require('./helpers')

const valid = {
  entryNumber: '2021cs10123',
  name: 'Kavya Test',
  email: 'CS1210123@IITD.AC.IN',
  password: 'a-strong-password',
  department: 'Computer Science',
  programme: 'B.Tech'
}

describe('student registration and login', () => {
  before(h.setup)
  after(h.teardown)
  beforeEach(h.resetDb)

  test('registers a student, normalises identifiers and never returns the hash', async () => {
    const res = await h.registerVerified(valid)
    assert.equal(res.status, 201)
    assert.equal(res.body.success, true)
    const { student, token } = res.body.data
    assert.equal(student.entryNumber, '2021CS10123')
    assert.equal(student.email, 'cs1210123@iitd.ac.in')
    assert.equal(student.passwordHash, undefined)
    assert.ok(token)

    const stored = await h.models.Student.findOne({ entryNumber: '2021CS10123' }).select(
      '+passwordHash'
    )
    assert.notEqual(stored.passwordHash, valid.password)
    assert.match(stored.passwordHash, /^\$2[aby]\$/)

    const me = await h.api().get('/api/auth/me').set('Authorization', `Bearer ${token}`)
    assert.equal(me.status, 200)
    assert.equal(me.body.data.student.entryNumber, '2021CS10123')
    assert.equal(me.body.data.student.passwordHash, undefined)
  })

  test('logs in with email or entry number; rejects a wrong password', async () => {
    await h.registerVerified(valid)
    const byEmail = await h
      .api()
      .post('/api/auth/login')
      .send({ identifier: 'cs1210123@iitd.ac.in', password: valid.password })
    assert.equal(byEmail.status, 200)
    assert.ok(byEmail.body.data.token)

    const byEntry = await h
      .api()
      .post('/api/auth/login')
      .send({ identifier: '2021cs10123', password: valid.password })
    assert.equal(byEntry.status, 200)

    const wrong = await h
      .api()
      .post('/api/auth/login')
      .send({ identifier: '2021CS10123', password: 'nope-nope-nope' })
    assert.equal(wrong.status, 401)
    assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS')

    const unknown = await h
      .api()
      .post('/api/auth/login')
      .send({ identifier: 'ghost@iitd.ac.in', password: 'whatever-123' })
    assert.equal(unknown.status, 401)
    assert.equal(unknown.body.error.code, 'INVALID_CREDENTIALS')
  })

  test('rejects duplicate entry numbers and duplicate emails', async () => {
    assert.equal((await h.registerVerified(valid)).status, 201)

    const sameEntry = await h.registerVerified({ ...valid, email: 'other@iitd.ac.in' })
    assert.equal(sameEntry.status, 409)
    assert.equal(sameEntry.body.error.code, 'DUPLICATE_STUDENT')

    const sameEmail = await h.registerVerified({
      ...valid,
      entryNumber: '2021CS10999',
      email: 'cs1210123@iitd.ac.in'
    })
    assert.equal(sameEmail.status, 409)
    assert.equal(sameEmail.body.error.code, 'DUPLICATE_STUDENT')
    assert.equal(await h.models.Student.countDocuments(), 1)
  })

  test('enforces the configured IIT Delhi email policy and input validation', async () => {
    const gmail = await h.registerVerified({ ...valid, email: 'x@gmail.com' })
    assert.equal(gmail.status, 400)
    assert.equal(gmail.body.error.code, 'EMAIL_NOT_ALLOWED')

    const lookalike = await h.registerVerified({ ...valid, email: 'x@eviliitd.ac.in' })
    assert.equal(lookalike.body.error.code, 'EMAIL_NOT_ALLOWED')

    const subdomain = await h.registerVerified({ ...valid, email: 'cs1210123@cse.iitd.ac.in' })
    assert.equal(subdomain.status, 201)

    const short = await h.registerVerified({
      ...valid,
      entryNumber: '2021CS1',
      email: 'a@iitd.ac.in',
      password: 'short'
    })
    assert.equal(short.status, 400)
    assert.equal(short.body.error.code, 'VALIDATION_ERROR')
  })

  test('logout revokes the token', async () => {
    const { token } = (await h.registerVerified(valid)).body.data
    const out = await h.api().post('/api/auth/logout').set('Authorization', `Bearer ${token}`)
    assert.equal(out.status, 200)
    const me = await h.api().get('/api/auth/me').set('Authorization', `Bearer ${token}`)
    assert.equal(me.status, 401)
  })

  test('an inactive student cannot log in', async () => {
    const { student, password } = await h.createStudent({ isActive: false })
    const res = await h.api().post('/api/auth/login').send({ identifier: student.email, password })
    assert.equal(res.status, 403)
    assert.equal(res.body.error.code, 'STUDENT_INACTIVE')
  })
})

describe('staff authentication', () => {
  before(h.setup)
  after(h.teardown)
  beforeEach(h.resetDb)

  test('staff login, me and logout', async () => {
    const { staff, password } = await h.createStaff('admin')
    const login = await h.api().post('/api/admin/login').send({ email: staff.email, password })
    assert.equal(login.status, 200)
    assert.equal(login.body.data.staff.passwordHash, undefined)
    const token = login.body.data.token

    const me = await h.api().get('/api/admin/me').set('Authorization', `Bearer ${token}`)
    assert.equal(me.status, 200)
    assert.equal(me.body.data.staff.role, 'admin')

    await h.api().post('/api/admin/logout').set('Authorization', `Bearer ${token}`).expect(200)
    await h.api().get('/api/admin/me').set('Authorization', `Bearer ${token}`).expect(401)
  })

  test('there is no public staff registration and bad passwords fail', async () => {
    const { staff } = await h.createStaff('admin')
    const bad = await h
      .api()
      .post('/api/admin/login')
      .send({ email: staff.email, password: 'wrong-password' })
    assert.equal(bad.status, 401)
    const register = await h
      .api()
      .post('/api/admin/register')
      .send({ email: 'a@b.c', password: 'x' })
    assert.equal(register.status, 401) // all other /api/admin routes require staff auth
  })
})
