const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const h = require('./helpers')
const { connectDatabase, disconnectDatabase } = require('../src/db/connect')
const { createHoldExpiryWorker } = require('../src/workers/holdExpiryWorker')
const visitService = require('../src/services/visitService')

const MIN = 60 * 1000

describe('restart and crash recovery', () => {
  let entryGate, exitGate, table
  before(h.setup)
  after(h.teardown)
  beforeEach(async () => {
    await h.resetDb()
    entryGate = await h.createTerminal('entry')
    exitGate = await h.createTerminal('exit')
    table = await h.createTable('Z1', 2)
  })

  test('holds that expire while the server is down are released on start-up', async () => {
    const s = await h.createStudentWithCard()
    const e = await h.must(h.enter(entryGate, s.cardUid, { tableId: table.table._id }), 201)
    await h.must(h.leave(exitGate, s.cardUid, 'hold'), 200)

    // "Crash": drop the connection with the hold still active; nothing in memory survives.
    await disconnectDatabase()
    h.advance(45 * MIN)
    await connectDatabase(h.mongoUri())

    // Fresh worker after restart: start() sweeps immediately.
    const worker = createHoldExpiryWorker({ intervalMs: 60 * MIN })
    await worker.start()
    worker.stop()

    const seat = await h.models.Seat.findById(e.body.data.seat.id).lean()
    assert.equal(seat.status, 'available')
    const session = await h.models.LibrarySession.findById(e.body.data.session.id).lean()
    assert.equal(session.status, 'completed')
    assert.equal(session.endReason, 'hold_expired')
    // endedAt is when the reservation lapsed, not when the server noticed.
    assert.equal(session.endedAt.toISOString(), session.holdUntil.toISOString())
  })

  test('the reconciler repairs half-finished writes left by a crash', async () => {
    const a = await h.createStudentWithCard()
    const b = await h.createStudentWithCard()
    const c = await h.createStudentWithCard()
    const [s1, s2] = table.seats

    // (1) Seat claimed but the session was closed (crash between steps).
    const closed = await h.models.LibrarySession.create({
      studentId: a.student._id,
      entryTime: h.now(),
      entryGateId: 'ENTRY-X',
      status: 'completed',
      seatId: s1._id,
      tableId: table.table._id
    })
    await h.models.Seat.updateOne(
      { _id: s1._id },
      { status: 'occupied', studentId: a.student._id, sessionId: closed._id }
    )
    // (2) Open session that never got a seat.
    const orphan = await h.models.LibrarySession.create({
      studentId: b.student._id,
      entryTime: h.now(),
      entryGateId: 'ENTRY-X',
      status: 'inside',
      tableId: table.table._id
    })
    // (3) Seat claimed and session open, but the session's seatId was never written.
    const unlinked = await h.models.LibrarySession.create({
      studentId: c.student._id,
      entryTime: h.now(),
      entryGateId: 'ENTRY-X',
      status: 'inside',
      tableId: table.table._id
    })
    await h.models.Seat.updateOne(
      { _id: s2._id },
      { status: 'occupied', studentId: c.student._id, sessionId: unlinked._id }
    )

    // Within the grace period nothing is touched (an in-flight request may own it).
    const changes = visitService.newChanges()
    assert.equal(await visitService.reconcile({ now: new Date() }, changes), 0)

    const later = new Date(Date.now() + 5 * MIN)
    assert.equal(await visitService.reconcile({ now: later }, changes), 3)
    assert.equal((await h.models.Seat.findById(s1._id)).status, 'available')
    const o = await h.models.LibrarySession.findById(orphan._id)
    assert.equal(o.status, 'completed')
    assert.equal(o.endReason, 'reconciled')
    const u = await h.models.LibrarySession.findById(unlinked._id)
    assert.equal(u.status, 'inside')
    assert.equal(String(u.seatId), String(s2._id))
    // Idempotent.
    assert.equal(await visitService.reconcile({ now: later }, changes), 0)
  })
})
