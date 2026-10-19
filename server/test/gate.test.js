const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const h = require('./helpers')
const { createHoldExpiryWorker } = require('../src/workers/holdExpiryWorker')

const MIN = 60 * 1000

describe('entry, exit and hold business rules', () => {
  let entryGate, exitGate, tA, tB
  before(h.setup)
  after(h.teardown)
  beforeEach(async () => {
    await h.resetDb()
    entryGate = await h.createTerminal('entry')
    exitGate = await h.createTerminal('exit')
    tA = await h.createTable('A1', 2)
    tB = await h.createTable('B1', 4)
  })

  async function seatOf(seatId) {
    return h.models.Seat.findById(seatId).lean()
  }

  test('successful entry creates one inside session and occupies the seat', async () => {
    const { student, cardUid } = await h.createStudentWithCard()
    const s = await h.scan(entryGate, cardUid)
    assert.equal(s.status, 200)
    assert.equal(s.body.data.accepted, true)
    assert.equal(s.body.data.nextAction, 'select_seat')
    assert.equal(s.body.data.student.displayName, 'Student')
    // A public gate never receives private student details.
    assert.equal(s.body.data.student.email, undefined)
    assert.notEqual(s.body.data.student.entryNumberMasked, student.entryNumber)

    const e = await h.entry(entryGate, { scanToken: s.body.data.scanToken, tableId: tA.table._id })
    assert.equal(e.status, 201)
    assert.equal(e.body.data.outcome, 'admitted')
    // Deterministic: the lowest-numbered free seat at the chosen table.
    assert.equal(e.body.data.seat.seatCode, 'A1-S1')

    const sessions = await h.models.LibrarySession.find({ studentId: student._id })
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].status, 'inside')
    assert.equal(sessions[0].entryGateId, entryGate.terminal.terminalCode)
    assert.equal(String(sessions[0].seatId), String(tA.seats[0]._id))
    const seat = await seatOf(tA.seats[0]._id)
    assert.equal(seat.status, 'occupied')
    assert.equal(String(seat.sessionId), String(sessions[0]._id))
    assert.ok(await h.models.AuditLog.exists({ action: 'entry.admitted', studentId: student._id }))
    assert.ok(await h.models.AuditLog.exists({ action: 'seat.allocated', studentId: student._id }))
  })

  test('a specific seat can be chosen; a taken seat is refused but the scan stays usable', async () => {
    const a = await h.createStudentWithCard()
    const b = await h.createStudentWithCard()
    await h.must(h.enter(entryGate, a.cardUid, { seatId: tB.seats[2]._id }), 201)

    const s = await h.scan(entryGate, b.cardUid)
    const taken = await h.entry(entryGate, {
      scanToken: s.body.data.scanToken,
      seatId: tB.seats[2]._id
    })
    assert.equal(taken.status, 409)
    assert.equal(taken.body.error.code, 'SEAT_UNAVAILABLE')
    const retry = await h.entry(entryGate, {
      scanToken: s.body.data.scanToken,
      seatId: tB.seats[3]._id
    })
    assert.equal(retry.status, 201)
    assert.equal(retry.body.data.seat.seatCode, 'B1-S4')
  })

  test('double entry is rejected without creating another visit', async () => {
    const { student, cardUid } = await h.createStudentWithCard()
    await h.must(h.enter(entryGate, cardUid, { tableId: tA.table._id }), 201)

    const again = await h.scan(entryGate, cardUid)
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'DUPLICATE_ENTRY')
    assert.equal(again.body.error.details.accepted, false)
    assert.equal(await h.models.LibrarySession.countDocuments({ studentId: student._id }), 1)
    assert.ok(
      await h.models.AuditLog.exists({ action: 'gate.scan.duplicate_entry', outcome: 'rejected' })
    )
  })

  test('unknown cards, revoked cards and inactive students are rejected and audited', async () => {
    const unknown = await h.scan(entryGate, 'DEADBEEF01')
    assert.equal(unknown.status, 403)
    assert.equal(unknown.body.error.code, 'UNKNOWN_CARD')

    const inactive = await h.createStudentWithCard({ isActive: false })
    const r1 = await h.scan(entryGate, inactive.cardUid)
    assert.equal(r1.status, 403)
    assert.equal(r1.body.error.code, 'STUDENT_INACTIVE')

    const revoked = await h.createStudentWithCard()
    await h.models.RFIDCard.updateOne({ _id: revoked.card._id }, { isActive: false })
    const r2 = await h.scan(entryGate, revoked.cardUid)
    assert.equal(r2.status, 403)
    assert.equal(r2.body.error.code, 'CARD_REVOKED')

    assert.equal(await h.models.LibrarySession.countDocuments(), 0)
    assert.equal(await h.models.AuditLog.countDocuments({ action: 'gate.scan.rejected' }), 3)
    // Raw card UIDs never reach the audit log.
    const logs = JSON.stringify(await h.models.AuditLog.find().lean())
    assert.ok(!logs.includes('DEADBEEF01'))
    assert.ok(!logs.includes(revoked.cardUid))
  })

  test('a student deactivated after scanning cannot complete entry', async () => {
    const { student, cardUid } = await h.createStudentWithCard()
    const s = await h.scan(entryGate, cardUid)
    await h.models.Student.updateOne({ _id: student._id }, { isActive: false })
    const e = await h.entry(entryGate, { scanToken: s.body.data.scanToken, tableId: tA.table._id })
    assert.equal(e.status, 403)
    assert.equal(e.body.error.code, 'STUDENT_INACTIVE')
    assert.equal(await h.models.LibrarySession.countDocuments(), 0)
  })

  test('allocation never exceeds table capacity', async () => {
    const students = []
    for (let i = 0; i < 3; i += 1) students.push(await h.createStudentWithCard())
    await h.must(h.enter(entryGate, students[0].cardUid, { tableId: tA.table._id }), 201)
    await h.must(h.enter(entryGate, students[1].cardUid, { tableId: tA.table._id }), 201)

    const s = await h.scan(entryGate, students[2].cardUid)
    const full = await h.entry(entryGate, {
      scanToken: s.body.data.scanToken,
      tableId: tA.table._id
    })
    assert.equal(full.status, 409)
    assert.equal(full.body.error.code, 'TABLE_FULL')
    assert.equal(
      await h.models.LibrarySession.countDocuments({ studentId: students[2].student._id }),
      0
    )
    assert.equal(
      await h.models.Seat.countDocuments({ tableId: tA.table._id, status: 'occupied' }),
      2
    )

    // Same scan, different table.
    const other = await h.entry(entryGate, {
      scanToken: s.body.data.scanToken,
      tableId: tB.table._id
    })
    assert.equal(other.status, 201)
  })

  test('immediate exit completes the session and releases the seat', async () => {
    const { student, cardUid } = await h.createStudentWithCard()
    const e = await h.enter(entryGate, cardUid, { tableId: tA.table._id })
    h.advance(90 * MIN)

    const s = await h.scan(exitGate, cardUid)
    assert.equal(s.body.data.nextAction, 'choose_exit')
    assert.deepEqual(s.body.data.exitOptions, ['exit', 'hold'])
    const x = await h.exit(exitGate, { scanToken: s.body.data.scanToken, mode: 'exit' })
    assert.equal(x.status, 200)
    assert.equal(x.body.data.outcome, 'exited')

    const session = await h.models.LibrarySession.findById(e.body.data.session.id).lean()
    assert.equal(session.status, 'completed')
    assert.equal(session.isOpen, false)
    assert.equal(session.exitGateId, exitGate.terminal.terminalCode)
    assert.equal(session.exitTime.toISOString(), h.now().toISOString())
    const seat = await seatOf(e.body.data.seat.id)
    assert.equal(seat.status, 'available')
    assert.equal(seat.sessionId, null)
    assert.equal(seat.studentId, null)
    assert.ok(await h.models.AuditLog.exists({ action: 'exit.completed', studentId: student._id }))
  })

  test('duplicate exit never releases a seat twice', async () => {
    const a = await h.createStudentWithCard()
    const b = await h.createStudentWithCard()
    const ea = await h.enter(entryGate, a.cardUid, { seatId: tA.seats[0]._id })
    const s = await h.scan(exitGate, a.cardUid)
    await h.exit(exitGate, { scanToken: s.body.data.scanToken, mode: 'exit' }).expect(200)

    // Seat is reused by B.
    await h.must(h.enter(entryGate, b.cardUid, { seatId: tA.seats[0]._id }), 201)

    // A network retry of the same exit replays the result instead of acting again.
    const replay = await h.exit(exitGate, { scanToken: s.body.data.scanToken, mode: 'exit' })
    assert.equal(replay.status, 200)
    assert.equal(replay.body.data.replayed, true)
    // A fresh scan by A is refused: they are no longer inside.
    const again = await h.scan(exitGate, a.cardUid)
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'NOT_INSIDE')

    const seat = await seatOf(ea.body.data.seat.id)
    assert.equal(seat.status, 'occupied')
    assert.equal(String(seat.studentId), String(b.student._id))
    assert.equal(
      await h.models.AuditLog.countDocuments({ action: 'seat.released', studentId: a.student._id }),
      1
    )
  })

  test('15-minute hold reserves the seat with a server-generated expiry', async () => {
    const { cardUid } = await h.createStudentWithCard()
    const e = await h.enter(entryGate, cardUid, { tableId: tA.table._id })
    h.advance(30 * MIN)
    const holdStart = h.now()

    const x = await h.leave(exitGate, cardUid, 'hold')
    assert.equal(x.status, 200)
    assert.equal(x.body.data.outcome, 'hold_started')
    const expected = new Date(holdStart.getTime() + 15 * MIN).toISOString()
    assert.equal(x.body.data.session.holdUntil, expected)

    const session = await h.models.LibrarySession.findById(e.body.data.session.id).lean()
    assert.equal(session.status, 'hold')
    assert.equal(session.isOpen, true)
    assert.equal(session.exitTime.toISOString(), holdStart.toISOString())
    const seat = await seatOf(e.body.data.seat.id)
    assert.equal(seat.status, 'reserved')
    assert.equal(seat.reservedUntil.toISOString(), expected)

    // The map shows it as reserved (yellow).
    const { token } = await h.createStudent()
    const map = await h.api().get('/api/library/map').set('Authorization', `Bearer ${token}`)
    const mapSeat = map.body.data.tables
      .flatMap((t) => t.seats)
      .find((s) => s.id === e.body.data.seat.id)
    assert.equal(mapSeat.status, 'reserved')
    assert.equal(map.body.data.legend.reserved.color, 'yellow')

    // A held student cannot start a second hold or exit again.
    const again = await h.scan(exitGate, cardUid)
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'ALREADY_ON_HOLD')
  })

  test('re-entry before expiry resumes the same session and seat', async () => {
    const { student, cardUid } = await h.createStudentWithCard()
    const e = await h.enter(entryGate, cardUid, { tableId: tB.table._id })
    await h.must(h.leave(exitGate, cardUid, 'hold'), 200)
    h.advance(14 * MIN + 59 * 1000)

    const s = await h.scan(entryGate, cardUid)
    assert.equal(s.body.data.nextAction, 'resume_hold')
    assert.equal(s.body.data.visit.seatCode, e.body.data.seat.seatCode)
    const r = await h.entry(entryGate, { scanToken: s.body.data.scanToken })
    assert.equal(r.status, 201)
    assert.equal(r.body.data.outcome, 'hold_resumed')
    assert.equal(r.body.data.session.id, e.body.data.session.id)
    assert.equal(r.body.data.seat.id, e.body.data.seat.id)

    assert.equal(await h.models.LibrarySession.countDocuments({ studentId: student._id }), 1)
    const session = await h.models.LibrarySession.findById(e.body.data.session.id).lean()
    assert.equal(session.status, 'inside')
    assert.equal(session.holdUntil, null)
    assert.equal(session.exitTime, null)
    assert.equal(session.resumeCount, 1)
    const seat = await seatOf(e.body.data.seat.id)
    assert.equal(seat.status, 'occupied')
    assert.equal(seat.reservedUntil, null)
  })

  test('a held seat cannot be taken by another student', async () => {
    const a = await h.createStudentWithCard()
    const b = await h.createStudentWithCard()
    const ea = await h.enter(entryGate, a.cardUid, { seatId: tA.seats[0]._id })
    await h.must(h.leave(exitGate, a.cardUid, 'hold'), 200)
    const s = await h.scan(entryGate, b.cardUid)
    const r = await h.entry(entryGate, {
      scanToken: s.body.data.scanToken,
      seatId: ea.body.data.seat.id
    })
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'SEAT_UNAVAILABLE')
  })

  test('the expiry worker releases the seat and finalises the visit after 15 minutes', async () => {
    const { cardUid } = await h.createStudentWithCard()
    const e = await h.enter(entryGate, cardUid, { tableId: tA.table._id })
    await h.must(h.leave(exitGate, cardUid, 'hold'), 200)
    const worker = createHoldExpiryWorker({ intervalMs: 60000 })

    h.advance(14 * MIN)
    await worker.tick()
    assert.equal((await seatOf(e.body.data.seat.id)).status, 'reserved')

    h.advance(1 * MIN)
    await worker.tick()
    const seat = await seatOf(e.body.data.seat.id)
    assert.equal(seat.status, 'available')
    assert.equal(seat.sessionId, null)
    const session = await h.models.LibrarySession.findById(e.body.data.session.id).lean()
    assert.equal(session.status, 'completed')
    assert.equal(session.endReason, 'hold_expired')
    assert.equal(session.isOpen, false)
    assert.ok(await h.models.AuditLog.exists({ action: 'hold.expired', sessionId: session._id }))
  })

  test('after expiry a new entry is a new visit that needs a newly available seat', async () => {
    const { student, cardUid } = await h.createStudentWithCard()
    const first = await h.enter(entryGate, cardUid, { tableId: tA.table._id })
    await h.must(h.leave(exitGate, cardUid, 'hold'), 200)
    h.advance(16 * MIN)
    // No worker run: expiry is applied lazily before the scan is evaluated.

    const s = await h.scan(entryGate, cardUid)
    assert.equal(s.body.data.nextAction, 'select_seat')
    const second = await h.entry(entryGate, {
      scanToken: s.body.data.scanToken,
      tableId: tB.table._id
    })
    assert.equal(second.status, 201)
    assert.equal(second.body.data.outcome, 'admitted')
    assert.notEqual(second.body.data.session.id, first.body.data.session.id)

    const sessions = await h.models.LibrarySession.find({ studentId: student._id })
      .sort({ entryTime: 1 })
      .lean()
    assert.equal(sessions.length, 2)
    assert.equal(sessions[0].status, 'completed')
    assert.equal(sessions[0].endReason, 'hold_expired')
    assert.equal(sessions[1].status, 'inside')
    assert.equal((await seatOf(first.body.data.seat.id)).status, 'available')
  })

  test('an expired hold never blocks another student even if the worker is late', async () => {
    const a = await h.createStudentWithCard()
    const b = await h.createStudentWithCard()
    const ea = await h.enter(entryGate, a.cardUid, { seatId: tA.seats[0]._id })
    await h.must(h.leave(exitGate, a.cardUid, 'hold'), 200)
    h.advance(15 * MIN + 1000)
    const eb = await h.enter(entryGate, b.cardUid, { seatId: ea.body.data.seat.id })
    assert.equal(eb.status, 201)
    assert.equal(eb.body.data.seat.id, ea.body.data.seat.id)
  })

  test('scan tokens are single-use, terminal-bound and gate-type-bound', async () => {
    const { cardUid } = await h.createStudentWithCard()
    const s = await h.scan(entryGate, cardUid)
    const token = s.body.data.scanToken

    const otherEntry = await h.createTerminal('entry')
    const foreign = await h.entry(otherEntry, { scanToken: token, tableId: tA.table._id })
    assert.equal(foreign.status, 403)
    assert.equal(foreign.body.error.code, 'SCAN_WRONG_GATE')

    const wrongType = await h.exit(exitGate, { scanToken: token, mode: 'exit' })
    assert.equal(wrongType.status, 403)

    const ok = await h.entry(entryGate, { scanToken: token, tableId: tA.table._id })
    assert.equal(ok.status, 201)
    const replay = await h.entry(entryGate, { scanToken: token, tableId: tB.table._id })
    assert.equal(replay.status, 200)
    assert.equal(replay.body.data.replayed, true)
    assert.equal(replay.body.data.seat.id, ok.body.data.seat.id)
    assert.equal(await h.models.LibrarySession.countDocuments(), 1)
  })

  test('scan tokens expire and a newer scan supersedes an older one', async () => {
    const a = await h.createStudentWithCard()
    const b = await h.createStudentWithCard()
    const sa = await h.scan(entryGate, a.cardUid)
    h.advance(3 * MIN)
    const late = await h.entry(entryGate, {
      scanToken: sa.body.data.scanToken,
      tableId: tA.table._id
    })
    assert.equal(late.status, 410)
    assert.equal(late.body.error.code, 'SCAN_EXPIRED')

    const sa2 = await h.scan(entryGate, a.cardUid)
    await h.scan(entryGate, b.cardUid)
    const superseded = await h.entry(entryGate, {
      scanToken: sa2.body.data.scanToken,
      tableId: tA.table._id
    })
    assert.equal(superseded.status, 410)
  })

  test('device retries with the same requestId are idempotent', async () => {
    const { cardUid } = await h.createStudentWithCard()
    const first = await h.scan(entryGate, cardUid, { requestId: 'esp32-abc-000001' })
    const retry = await h.scan(entryGate, cardUid, { requestId: 'esp32-abc-000001' })
    assert.equal(first.status, 200)
    assert.equal(retry.status, 200)
    assert.equal(retry.body.data.replayed, true)
    assert.equal(retry.body.data.scanToken, undefined)
    assert.equal(await h.models.GateScan.countDocuments(), 1)
    // The original token is still the live one.
    await h
      .entry(entryGate, { scanToken: first.body.data.scanToken, tableId: tA.table._id })
      .expect(201)
  })

  test('status endpoint: students see only themselves, staff see anyone', async () => {
    const a = await h.createStudentWithCard()
    const b = await h.createStudent()
    await h.must(h.enter(entryGate, a.cardUid, { tableId: tA.table._id }), 201)
    const own = await h
      .api()
      .get(`/api/gate/status/${a.student.entryNumber}`)
      .set('Authorization', `Bearer ${a.token}`)
    assert.equal(own.status, 200)
    assert.equal(own.body.data.state, 'inside')
    assert.equal(own.body.data.visit.tableCode, 'A1')

    const other = await h
      .api()
      .get(`/api/gate/status/${a.student.entryNumber}`)
      .set('Authorization', `Bearer ${b.token}`)
    assert.equal(other.status, 403)

    const { token } = await h.createStaff('staff')
    const staff = await h
      .api()
      .get(`/api/gate/status/${a.student.entryNumber}`)
      .set('Authorization', `Bearer ${token}`)
    assert.equal(staff.status, 200)
  })

  test('staff-assisted allocation uses the same rules', async () => {
    const { student } = await h.createStudent()
    const { token } = await h.createStaff('staff')
    const res = await h
      .api()
      .post('/api/library/seats/allocate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entryNumber: student.entryNumber,
        terminalCode: entryGate.terminal.terminalCode,
        tableId: tA.table._id
      })
    assert.equal(res.status, 201)
    const dup = await h
      .api()
      .post('/api/library/seats/allocate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        entryNumber: student.entryNumber,
        terminalCode: entryGate.terminal.terminalCode,
        tableId: tB.table._id
      })
    assert.equal(dup.status, 409)
    assert.equal(dup.body.error.code, 'DUPLICATE_ENTRY')
  })

  test('occupancy reflects seat states', async () => {
    const a = await h.createStudentWithCard()
    const b = await h.createStudentWithCard()
    await h.must(h.enter(entryGate, a.cardUid, { tableId: tA.table._id }), 201)
    await h.must(h.enter(entryGate, b.cardUid, { tableId: tB.table._id }), 201)
    await h.must(h.leave(exitGate, b.cardUid, 'hold'), 200)
    const res = await h
      .api()
      .get('/api/library/occupancy')
      .set('Authorization', `Bearer ${a.token}`)
    assert.deepEqual(
      { ...res.body.data, serverTime: undefined },
      {
        capacity: 6,
        available: 4,
        occupied: 1,
        reserved: 1,
        studentsInside: 1,
        studentsOnHold: 1,
        serverTime: undefined
      }
    )
  })
})
