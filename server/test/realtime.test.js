const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { io: connect } = require('socket.io-client')
const h = require('./helpers')
const { createApp } = require('../src/app')
const { initSocket } = require('../src/realtime/socket')
const authService = require('../src/services/authService')

describe('socket updates follow committed database changes', () => {
  let entryGate, exitGate, table
  before(h.setup)
  after(h.teardown)
  beforeEach(async () => {
    await h.resetDb()
    entryGate = await h.createTerminal('entry')
    exitGate = await h.createTerminal('exit')
    table = await h.createTable('R1', 1)
    h.clearEvents()
  })

  test('a successful entry emits map, occupancy and session updates that match the database', async () => {
    const s = await h.createStudentWithCard()
    const scan = await h.must(h.scan(entryGate, s.cardUid), 200)
    // The scan result goes only to the scanning terminal's room.
    const gate = h.events('gate:result')
    assert.equal(gate.length, 1)
    assert.equal(gate[0].room, `terminal:${entryGate.terminal.terminalCode}`)
    assert.equal(h.events('map:updated').length, 0)

    await h.must(
      h.entry(entryGate, { scanToken: scan.body.data.scanToken, tableId: table.table._id }),
      201
    )
    const map = h.events('map:updated', 'map')
    assert.equal(map.length, 1)
    assert.equal(map[0].payload.seats[0].status, 'occupied')
    assert.equal(map[0].payload.seats[0].studentId, undefined) // never who sits there
    const occ = h.events('occupancy:updated', 'map')
    assert.equal(occ[0].payload.occupied, 1)
    const sess = h.events('session:updated', `student:${s.student._id}`)
    assert.equal(sess[0].payload.status, 'inside')
  })

  test('failed operations emit no map or session updates', async () => {
    const a = await h.createStudentWithCard()
    const b = await h.createStudentWithCard()
    await h.must(h.enter(entryGate, a.cardUid, { tableId: table.table._id }), 201)
    h.clearEvents()

    const scan = await h.must(h.scan(entryGate, b.cardUid), 409) // LIBRARY_FULL: only seat taken
    assert.equal(scan.body.error.code, 'LIBRARY_FULL')
    const dupScan = await h.scan(entryGate, a.cardUid)
    assert.equal(dupScan.body.error.code, 'DUPLICATE_ENTRY')
    const notInside = await h.scan(exitGate, b.cardUid)
    assert.equal(notInside.body.error.code, 'NOT_INSIDE')

    assert.equal(h.events('map:updated').length, 0)
    assert.equal(h.events('occupancy:updated').length, 0)
    assert.equal(h.events('session:updated').length, 0)
    // Rejections are still reported to the gate and to admins.
    assert.equal(h.events('gate:result').length, 3)
    assert.ok(h.events('admin:log', 'admin').length >= 3)
  })

  test('if the transaction fails, nothing is broadcast and nothing is persisted', async () => {
    const s = await h.createStudentWithCard()
    const scan = await h.must(h.scan(entryGate, s.cardUid), 200)
    h.clearEvents()
    const original = h.models.Seat.findOneAndUpdate
    h.models.Seat.findOneAndUpdate = function () {
      throw new Error('simulated database failure')
    }
    try {
      const res = await h.entry(entryGate, {
        scanToken: scan.body.data.scanToken,
        tableId: table.table._id
      })
      assert.equal(res.status, 500)
      assert.equal(res.body.error.code, 'INTERNAL_ERROR')
      assert.ok(!JSON.stringify(res.body).includes('simulated'))
    } finally {
      h.models.Seat.findOneAndUpdate = original
    }
    assert.equal(h.events('map:updated').length, 0)
    assert.equal(h.events('session:updated').length, 0)
    assert.equal(await h.models.LibrarySession.countDocuments(), 0)
    assert.equal((await h.models.Seat.findById(table.seats[0]._id)).status, 'available')
  })

  test('hold expiry by the worker emits a release update', async () => {
    const s = await h.createStudentWithCard()
    await h.must(h.enter(entryGate, s.cardUid, { tableId: table.table._id }), 201)
    await h.must(h.leave(exitGate, s.cardUid, 'hold'), 200)
    const reserved = h.events('map:updated', 'map').at(-1)
    assert.equal(reserved.payload.seats[0].status, 'reserved')
    assert.ok(reserved.payload.seats[0].reservedUntil)
    h.clearEvents()
    h.advance(15 * 60 * 1000)
    const { createHoldExpiryWorker } = require('../src/workers/holdExpiryWorker')
    await createHoldExpiryWorker({ intervalMs: 60000 }).tick()
    const released = h.events('map:updated', 'map')
    assert.equal(released.length, 1)
    assert.equal(released[0].payload.seats[0].status, 'available')
  })

  test('a lazily expired hold is broadcast even when the triggering request fails', async () => {
    const a = await h.createStudentWithCard()
    await h.must(h.enter(entryGate, a.cardUid, { tableId: table.table._id }), 201)
    await h.must(h.leave(exitGate, a.cardUid, 'hold'), 200)
    h.advance(20 * 60 * 1000)
    h.clearEvents()
    // A scans at the exit after the hold lapsed: rejected (NOT_INSIDE), but expiring
    // the hold during that request committed and must reach map clients.
    const res = await h.must(h.scan(exitGate, a.cardUid), 409)
    assert.equal(res.body.error.code, 'NOT_INSIDE')
    const released = h.events('map:updated', 'map')
    assert.equal(released.length, 1)
    assert.equal(released[0].payload.seats[0].status, 'available')
  })
})

describe('Socket.IO authentication and subscriptions', () => {
  let server, url, entryGate
  before(async () => {
    await h.setup()
    server = http.createServer(createApp())
    initSocket(server, { corsOrigin: (_o, cb) => cb(null, true) })
    await new Promise((r) => server.listen(0, r))
    url = `http://127.0.0.1:${server.address().port}`
  })
  after(async () => {
    await new Promise((r) => server.close(r))
    await h.teardown()
  })
  beforeEach(async () => {
    await h.resetDb()
    entryGate = await h.createTerminal('entry')
    await h.createTable('S1', 2)
  })

  function client(token) {
    return connect(url, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false
    })
  }
  function once(socket, event) {
    return new Promise((resolve, reject) => {
      socket.once(event, resolve)
      socket.once('connect_error', reject)
    })
  }
  function emitAck(socket, event, payload) {
    return new Promise((resolve) => socket.emit(event, payload, resolve))
  }

  test('connections without a valid token are refused', async () => {
    const anon = client(null)
    const err = await new Promise((resolve) => anon.once('connect_error', resolve))
    assert.equal(err.message, 'UNAUTHENTICATED')
    anon.close()
    const forged = client('forged.token.value')
    await new Promise((resolve) => forged.once('connect_error', resolve))
    forged.close()
  })

  test('only terminals may subscribe to a gate, and only to their own', async () => {
    const { token: studentToken } = await h.createStudent()
    const student = client(studentToken)
    await once(student, 'connect')
    const denied = await emitAck(student, 'gate:subscribe', {
      terminalCode: entryGate.terminal.terminalCode
    })
    assert.equal(denied.ok, false)
    const adminDenied = await emitAck(student, 'admin:subscribe', {})
    assert.equal(adminDenied.ok, false)
    const mapOk = await emitAck(student, 'map:subscribe', {})
    assert.equal(mapOk.ok, true)
    student.close()

    const termToken = authService.issueTerminalToken(entryGate.terminal).token
    const term = client(termToken)
    await once(term, 'connect')
    const other = await emitAck(term, 'gate:subscribe', { terminalCode: 'EXIT-999' })
    assert.equal(other.ok, false)
    const own = await emitAck(term, 'gate:subscribe', {
      terminalCode: entryGate.terminal.terminalCode
    })
    assert.equal(own.ok, true)
    term.close()
  })

  test('a subscribed kiosk receives the scan result and map clients receive the update', async () => {
    const s = await h.createStudentWithCard()
    const kiosk = client(authService.issueTerminalToken(entryGate.terminal).token)
    await once(kiosk, 'connect')
    await emitAck(kiosk, 'gate:subscribe', {})
    const viewer = client(s.token)
    await once(viewer, 'connect')
    await emitAck(viewer, 'map:subscribe', {})

    // Real Socket.IO server for this suite (helpers installed a recording double).
    const gotScan = once(kiosk, 'gate:result')
    const res = await h.must(h.scan(entryGate, s.cardUid), 200)
    const pushed = await gotScan
    assert.equal(pushed.scanToken, res.body.data.scanToken)
    assert.equal(pushed.nextAction, 'select_seat')

    const gotMap = once(viewer, 'map:updated')
    const gotSession = once(viewer, 'session:updated')
    const tables = await h
      .api()
      .get('/api/library/tables')
      .set('Authorization', `Bearer ${s.token}`)
    await h.must(
      h.entry(entryGate, { scanToken: pushed.scanToken, tableId: tables.body.data.tables[0].id }),
      201
    )
    const update = await gotMap
    assert.equal(update.seats[0].status, 'occupied')
    assert.equal((await gotSession).status, 'inside')
    kiosk.close()
    viewer.close()
  })
})
