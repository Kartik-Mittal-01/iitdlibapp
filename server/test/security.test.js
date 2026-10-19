const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const h = require('./helpers')
const authService = require('../src/services/authService')

describe('authorization of admin and terminal requests', () => {
  before(h.setup)
  after(h.teardown)
  beforeEach(h.resetDb)

  test('admin routes reject anonymous, student and terminal callers', async () => {
    const { token: studentToken } = await h.createStudent()
    const term = await h.createTerminal('entry')
    const termToken = authService.issueTerminalToken(term.terminal).token
    for (const path of [
      '/api/admin/logs',
      '/api/admin/students',
      '/api/admin/sessions',
      '/api/admin/terminals'
    ]) {
      assert.equal((await h.api().get(path)).status, 401, path)
      assert.equal(
        (await h.api().get(path).set('Authorization', `Bearer ${studentToken}`)).status,
        403,
        path
      )
      assert.equal(
        (await h.api().get(path).set('Authorization', `Bearer ${termToken}`)).status,
        403,
        path
      )
      assert.equal(
        (await h.api().get(path).set('Authorization', 'Bearer not-a-jwt')).status,
        401,
        path
      )
    }
  })

  test('staff role cannot perform admin-only changes', async () => {
    const { token } = await h.createStaff('staff')
    const { student } = await h.createStudent()
    const term = await h.createTerminal('exit')
    const patchStudent = await h
      .api()
      .patch(`/api/admin/students/${student._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false })
    assert.equal(patchStudent.status, 403)
    const patchTerm = await h
      .api()
      .patch(`/api/admin/terminals/${term.terminal._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false })
    assert.equal(patchTerm.status, 403)
    // ...but can read logs.
    assert.equal(
      (await h.api().get('/api/admin/logs').set('Authorization', `Bearer ${token}`)).status,
      200
    )
  })

  test('admin can deactivate a student and a terminal; changes are audited', async () => {
    const { token } = await h.createStaff('admin')
    const s = await h.createStudentWithCard()
    const term = await h.createTerminal('entry')
    await h
      .api()
      .patch(`/api/admin/students/${s.student._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false })
      .expect(200)
    const scan = await h.scan(term, s.cardUid)
    assert.equal(scan.body.error.code, 'STUDENT_INACTIVE')

    await h
      .api()
      .patch(`/api/admin/terminals/${term.terminal._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isActive: false })
      .expect(200)
    const blocked = await h.scan(term, s.cardUid)
    assert.equal(blocked.status, 401)
    assert.equal(blocked.body.error.code, 'TERMINAL_UNAUTHORIZED')

    assert.ok(await h.models.AuditLog.exists({ action: 'admin.student_updated' }))
    assert.ok(await h.models.AuditLog.exists({ action: 'admin.terminal_updated' }))
  })

  test('gate endpoints reject unauthenticated or forged terminals', async () => {
    const s = await h.createStudentWithCard()
    const term = await h.createTerminal('entry')
    const none = await h.api().post('/api/gate/scan').send({ cardUid: s.cardUid })
    assert.equal(none.status, 401)
    const badKey = await h
      .api()
      .post('/api/gate/scan')
      .set({ 'X-Terminal-Code': term.terminal.terminalCode, 'X-Terminal-Key': 'guess' })
      .send({ cardUid: s.cardUid })
    assert.equal(badKey.status, 401)
    const unknown = await h
      .api()
      .post('/api/gate/scan')
      .set({ 'X-Terminal-Code': 'NOPE-1', 'X-Terminal-Key': term.key })
      .send({ cardUid: s.cardUid })
    assert.equal(unknown.status, 401)
    // Students and staff are not terminals.
    const asStudent = await h
      .api()
      .post('/api/gate/scan')
      .set('Authorization', `Bearer ${s.token}`)
      .send({ cardUid: s.cardUid })
    assert.equal(asStudent.status, 403)
    // A client cannot choose its gate type: an entry terminal cannot run exits.
    const exitOnEntry = await h
      .api()
      .post('/api/gate/exit')
      .set(term.headers)
      .send({ scanToken: 'x'.repeat(43), mode: 'exit' })
    assert.equal(exitOnEntry.status, 403)
    assert.equal(await h.models.LibrarySession.countDocuments(), 0)
    assert.ok(await h.models.AuditLog.exists({ action: 'terminal.auth_failed' }))
  })

  test('terminal tokens work until the key is rotated', async () => {
    const { token: adminToken } = await h.createStaff('admin')
    const term = await h.createTerminal('entry')
    const issued = await h.api().post('/api/gate/terminal/token').set(term.headers)
    assert.equal(issued.status, 200)
    const bearer = { Authorization: `Bearer ${issued.body.data.token}` }
    assert.equal((await h.api().get('/api/gate/terminal/me').set(bearer)).status, 200)

    const rotated = await h
      .api()
      .post(`/api/admin/terminals/${term.terminal._id}/rotate-key`)
      .set('Authorization', `Bearer ${adminToken}`)
    assert.equal(rotated.status, 200)
    assert.ok(rotated.body.data.terminalKey)
    assert.equal((await h.api().get('/api/gate/terminal/me').set(bearer)).status, 401)
    assert.equal((await h.api().post('/api/gate/terminal/token').set(term.headers)).status, 401)
  })

  test('responses never leak password hashes, card hashes or terminal credentials', async () => {
    const { token } = await h.createStaff('admin')
    await h.createStudentWithCard()
    await h.createTerminal('exit')
    for (const path of ['/api/admin/students', '/api/admin/terminals', '/api/admin/cards']) {
      const res = await h.api().get(path).set('Authorization', `Bearer ${token}`)
      assert.equal(res.status, 200, path)
      const text = JSON.stringify(res.body)
      assert.ok(!/passwordHash|cardUidHash|credentialHash/.test(text), path)
    }
  })

  test('admin logs support pagination, filters and date ranges', async () => {
    const { token } = await h.createStaff('admin')
    const term = await h.createTerminal('entry')
    for (let i = 0; i < 7; i += 1) await h.scan(term, `DEAD00${i}0FF`)
    const auth = { Authorization: `Bearer ${token}` }

    const page1 = await h.api().get('/api/admin/logs?action=gate.scan.rejected&limit=5').set(auth)
    assert.equal(page1.status, 200)
    assert.equal(page1.body.data.items.length, 5)
    assert.equal(page1.body.data.total, 7)
    assert.equal(page1.body.data.totalPages, 2)
    const page2 = await h
      .api()
      .get('/api/admin/logs?action=gate.scan.rejected&limit=5&page=2')
      .set(auth)
    assert.equal(page2.body.data.items.length, 2)

    const prefix = await h.api().get('/api/admin/logs?action=gate.*').set(auth)
    assert.equal(prefix.body.data.total, 7)
    const future = await h.api().get('/api/admin/logs?from=2099-01-01').set(auth)
    assert.equal(future.body.data.total, 0)
    const bad = await h.api().get('/api/admin/logs?from=yesterday').set(auth)
    assert.equal(bad.status, 400)
  })

  test('errors are structured and do not expose internals', async () => {
    const res = await h
      .api()
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{bad json')
    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'VALIDATION_ERROR')
    assert.ok(!JSON.stringify(res.body).includes('at '))
    const missing = await h.api().get('/api/nope')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.success, false)
  })

  test('health and readiness', async () => {
    const health = await h.api().get('/api/health')
    assert.equal(health.status, 200)
    const ready = await h.api().get('/api/ready')
    assert.equal(ready.status, 200)
    assert.equal(ready.body.data.mongodb, 'up')
    assert.equal(ready.body.data.transactions, !h.STANDALONE)
  })
})
