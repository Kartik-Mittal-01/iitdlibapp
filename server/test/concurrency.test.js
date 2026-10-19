const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const h = require('./helpers')
const visitService = require('../src/services/visitService')

describe('concurrency', () => {
  let entryGate, exitGate, table
  before(h.setup)
  after(h.teardown)
  beforeEach(async () => {
    await h.resetDb()
    entryGate = await h.createTerminal('entry')
    exitGate = await h.createTerminal('exit')
    table = await h.createTable('C1', 3)
  })

  test('many students racing for one seat: exactly one wins', async () => {
    const N = 12
    // Each student scans at their own entry terminal so all tokens are live at once.
    const contenders = []
    for (let i = 0; i < N; i += 1) {
      const term = await h.createTerminal('entry')
      const s = await h.createStudentWithCard()
      const scan = await h.must(h.scan(term, s.cardUid), 200)
      contenders.push({ term, token: scan.body.data.scanToken })
    }
    const seatId = table.seats[0]._id
    const results = await Promise.all(
      contenders.map((c) => h.entry(c.term, { scanToken: c.token, seatId }))
    )
    const wins = results.filter((r) => r.status === 201)
    const losses = results.filter((r) => r.status === 409)
    assert.equal(wins.length, 1, JSON.stringify(results.map((r) => r.body)))
    assert.equal(losses.length, N - 1)
    assert.ok(losses.every((r) => r.body.error.code === 'SEAT_UNAVAILABLE'))
    assert.equal(await h.models.LibrarySession.countDocuments({ isOpen: true }), 1)
    const seat = await h.models.Seat.findById(seatId).lean()
    assert.equal(seat.status, 'occupied')
    const winnerSession = await h.models.LibrarySession.findById(
      wins[0].body.data.session.id
    ).lean()
    assert.equal(String(seat.sessionId), String(winnerSession._id))
  })

  test('many students racing for one table never exceed its capacity', async () => {
    const N = 10
    const contenders = []
    for (let i = 0; i < N; i += 1) {
      const term = await h.createTerminal('entry')
      const s = await h.createStudentWithCard()
      const scan = await h.must(h.scan(term, s.cardUid), 200)
      contenders.push({ term, token: scan.body.data.scanToken })
    }
    const results = await Promise.all(
      contenders.map((c) => h.entry(c.term, { scanToken: c.token, tableId: table.table._id }))
    )
    assert.equal(results.filter((r) => r.status === 201).length, 3)
    assert.ok(
      results.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'TABLE_FULL')
    )
    const seats = await h.models.Seat.find({ tableId: table.table._id }).lean()
    assert.ok(seats.every((s) => s.status === 'occupied'))
    assert.equal(new Set(seats.map((s) => String(s.sessionId))).size, 3)
    assert.equal(await h.models.LibrarySession.countDocuments({ isOpen: true }), 3)
  })

  test('one student entering at two gates at once gets exactly one visit', async () => {
    const other = await h.createTable('C2', 3)
    const s = await h.createStudentWithCard()
    const gates = [entryGate, await h.createTerminal('entry'), await h.createTerminal('entry')]
    const tokens = []
    for (const g of gates)
      tokens.push((await h.must(h.scan(g, s.cardUid), 200)).body.data.scanToken)
    const results = await Promise.all(
      gates.map((g, i) =>
        h.entry(g, { scanToken: tokens[i], tableId: i % 2 ? other.table._id : table.table._id })
      )
    )
    assert.equal(
      results.filter((r) => r.status === 201).length,
      1,
      JSON.stringify(results.map((r) => r.body))
    )
    assert.ok(
      results.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'DUPLICATE_ENTRY'),
      JSON.stringify(results.map((r) => r.body))
    )
    assert.equal(await h.models.LibrarySession.countDocuments({ studentId: s.student._id }), 1)
    assert.equal(await h.models.Seat.countDocuments({ studentId: s.student._id }), 1)
  })

  test('the same scan token submitted concurrently acts once', async () => {
    const s = await h.createStudentWithCard()
    const scan = await h.must(h.scan(entryGate, s.cardUid), 200)
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        h.entry(entryGate, { scanToken: scan.body.data.scanToken, tableId: table.table._id })
      )
    )
    const created = results.filter((r) => r.status === 201)
    assert.equal(created.length, 1)
    // Others either saw it in progress or replayed the stored result.
    assert.ok(
      results
        .filter((r) => r.status !== 201)
        .every((r) => r.body.error?.code === 'SCAN_IN_PROGRESS' || r.body.data?.replayed === true),
      JSON.stringify(results.map((r) => r.body))
    )
    assert.equal(await h.models.LibrarySession.countDocuments(), 1)
  })

  test('concurrent exit and hold for one visit: only one applies', async () => {
    const s = await h.createStudentWithCard()
    await h.must(h.enter(entryGate, s.cardUid, { tableId: table.table._id }), 201)
    const exit2 = await h.createTerminal('exit')
    const t1 = (await h.must(h.scan(exitGate, s.cardUid), 200)).body.data.scanToken
    const t2 = (await h.must(h.scan(exit2, s.cardUid), 200)).body.data.scanToken
    const [a, b] = await Promise.all([
      h.exit(exitGate, { scanToken: t1, mode: 'exit' }),
      h.exit(exit2, { scanToken: t2, mode: 'hold' })
    ])
    const statuses = [a.status, b.status].sort()
    assert.deepEqual(statuses, [200, 409], JSON.stringify([a.body, b.body]))
    const session = await h.models.LibrarySession.findOne({ studentId: s.student._id }).lean()
    const seat = await h.models.Seat.findById(session.seatId).lean()
    if (session.status === 'completed') {
      assert.equal(seat.status, 'available')
    } else {
      assert.equal(session.status, 'hold')
      assert.equal(seat.status, 'reserved')
    }
    assert.ok(
      (await h.models.AuditLog.countDocuments({
        action: 'seat.released',
        studentId: s.student._id
      })) <= 1
    )
  })

  // Service-level races (no scan-token serialisation): the conditional updates
  // themselves must make duplicates impossible.
  test('concurrent exits for one visit release the seat exactly once', async () => {
    const s = await h.createStudentWithCard()
    await h.must(h.enter(entryGate, s.cardUid, { tableId: table.table._id }), 201)
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        visitService.exitStudent(
          {
            studentId: s.student._id,
            terminal: exitGate.terminal,
            mode: i % 2 ? 'hold' : 'exit',
            actor: null
          },
          visitService.newChanges()
        )
      )
    )
    const ok = results.filter((r) => r.status === 'fulfilled')
    assert.equal(
      ok.length,
      1,
      JSON.stringify(results.map((r) => r.reason?.code || r.value?.outcome))
    )
    assert.ok(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) =>
          ['DUPLICATE_EXIT', 'ALREADY_ON_HOLD', 'NOT_INSIDE', 'STATE_CHANGED'].includes(
            r.reason.code
          )
        )
    )
    assert.ok(
      (await h.models.AuditLog.countDocuments({
        action: { $in: ['seat.released', 'hold.created'] }
      })) === 1
    )
  })

  test('concurrent admissions for one student create exactly one visit', async () => {
    const s = await h.createStudentWithCard()
    const other = await h.createTable('C3', 4)
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        visitService.admitStudent(
          {
            studentId: s.student._id,
            terminal: entryGate.terminal,
            tableId: i % 2 ? other.table._id : table.table._id,
            actor: null
          },
          visitService.newChanges()
        )
      )
    )
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.ok(
      results
        .filter((r) => r.status === 'rejected')
        .every((r) => r.reason.code === 'DUPLICATE_ENTRY')
    )
    assert.equal(await h.models.LibrarySession.countDocuments({ studentId: s.student._id }), 1)
    assert.equal(await h.models.Seat.countDocuments({ studentId: s.student._id }), 1)
  })
})
