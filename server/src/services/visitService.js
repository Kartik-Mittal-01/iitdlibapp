// Core visit lifecycle: admission (new visit or hold resume), exit, 15-minute
// hold, hold expiry and consistency repair.
//
// Every state change is a conditional update on the current state, so a
// duplicate or concurrent request can never apply twice. When the deployment
// supports transactions the session and seat updates commit together; on a
// standalone server each step is still conditional, failures are compensated
// inline, and reconcile() repairs anything a crash may leave half-done.
//
// Functions take a `changes` accumulator ({ seatIds, sessionIds }). Ids are
// pushed only after the corresponding write has committed; the caller
// broadcasts them once the request finishes (publisher.publish).

const { Seat, LibrarySession, LibraryTable, Student } = require('../models')
const { withAtomic, opts } = require('../db/connect')
const clock = require('./clock')
const audit = require('./auditService')
const AppError = require('../utils/AppError')
const { SEAT_STATUS, SESSION_STATUS, HOLD_DURATION_MS, EXIT_MODES } = require('../shared')

const AFTER = { returnDocument: 'after' }
const RECONCILE_GRACE_MS = 60 * 1000

const SEAT_RELEASE = {
  status: SEAT_STATUS.AVAILABLE,
  studentId: null,
  sessionId: null,
  reservedUntil: null
}

function newChanges() {
  return { seatIds: [], sessionIds: [] }
}

function track(changes, { seatId, sessionId }) {
  if (!changes) return
  if (seatId) changes.seatIds.push(seatId)
  if (sessionId) changes.sessionIds.push(sessionId)
}

function isDuplicateKey(err) {
  return err && (err.code === 11000 || err.errorResponse?.code === 11000)
}

function systemActor() {
  return null
}

// ---------------------------------------------------------------------------
// Hold expiry
// ---------------------------------------------------------------------------

async function finalizeExpiredHold({ _id, holdUntil }, now, changes) {
  const result = await withAtomic(async (session) => {
    const closed = await LibrarySession.findOneAndUpdate(
      { _id, status: SESSION_STATUS.HOLD, holdUntil, isOpen: true },
      {
        $set: {
          status: SESSION_STATUS.COMPLETED,
          isOpen: false,
          endedAt: holdUntil,
          endReason: 'hold_expired'
        }
      },
      opts(session, AFTER)
    )
    if (!closed) return null // already resumed or finalised by another worker
    const seat = await Seat.findOneAndUpdate(
      { _id: closed.seatId, sessionId: closed._id },
      { $set: SEAT_RELEASE },
      opts(session, AFTER)
    )
    return { closed, seat }
  })
  if (!result) return false

  const { closed, seat } = result
  track(changes, { seatId: closed.seatId, sessionId: closed._id })
  await audit.record({
    actor: systemActor(),
    action: 'hold.expired',
    studentId: closed.studentId,
    sessionId: closed._id,
    details: { holdUntil, processedAt: now }
  })
  if (seat) {
    await audit.record({
      actor: systemActor(),
      action: 'seat.released',
      studentId: closed.studentId,
      sessionId: closed._id,
      reason: 'hold_expired',
      details: { seatCode: seat.seatCode }
    })
  }
  return true
}

/**
 * Finalises every hold whose holdUntil has passed (optionally scoped to one
 * student or table). Called by the background worker and, lazily, before any
 * entry, exit, scan or map read, so a delayed worker never leaves an expired
 * reservation blocking a seat.
 */
async function expireDueHolds(
  { now = clock.now(), studentId, tableId, limit = 500 } = {},
  changes
) {
  const filter = { status: SESSION_STATUS.HOLD, holdUntil: { $lte: now } }
  if (studentId) filter.studentId = studentId
  if (tableId) filter.tableId = tableId
  const due = await LibrarySession.find(filter)
    .sort({ holdUntil: 1 })
    .limit(limit)
    .select('_id holdUntil')
    .lean()
  let count = 0
  for (const s of due) {
    if (await finalizeExpiredHold(s, now, changes)) count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function describe(sessionDoc, seat, table) {
  return {
    session: {
      id: String(sessionDoc._id),
      status: sessionDoc.status,
      entryTime: sessionDoc.entryTime,
      exitTime: sessionDoc.exitTime,
      holdUntil: sessionDoc.holdUntil
    },
    seat: seat
      ? { id: String(seat._id), seatCode: seat.seatCode, seatNumber: seat.seatNumber }
      : null,
    table: table ? { id: String(table._id), tableCode: table.tableCode, name: table.name } : null
  }
}

async function loadEligibleStudent(studentId) {
  const student = await Student.findById(studentId)
  if (!student) throw AppError.forbidden('UNKNOWN_CARD')
  if (!student.isActive) throw AppError.forbidden('STUDENT_INACTIVE')
  return student
}

async function resumeHold(open, { terminal, actor, now }, changes) {
  const { resumed, seat } = await withAtomic(async (session) => {
    const resumedDoc = await LibrarySession.findOneAndUpdate(
      { _id: open._id, status: SESSION_STATUS.HOLD, holdUntil: { $gt: now } },
      {
        $set: {
          status: SESSION_STATUS.INSIDE,
          isOpen: true,
          exitTime: null,
          exitGateId: null,
          holdUntil: null,
          lastResumedAt: now
        },
        $inc: { resumeCount: 1 }
      },
      opts(session, AFTER)
    )
    if (!resumedDoc) throw AppError.conflict('STATE_CHANGED')
    const seatDoc = await Seat.findOneAndUpdate(
      { _id: resumedDoc.seatId, sessionId: resumedDoc._id, status: SEAT_STATUS.RESERVED },
      { $set: { status: SEAT_STATUS.OCCUPIED, reservedUntil: null } },
      opts(session, AFTER)
    )
    if (!seatDoc) {
      if (!session) {
        await LibrarySession.updateOne(
          { _id: resumedDoc._id, status: SESSION_STATUS.INSIDE },
          {
            $set: {
              status: SESSION_STATUS.HOLD,
              exitTime: open.exitTime,
              exitGateId: open.exitGateId,
              holdUntil: open.holdUntil,
              lastResumedAt: open.lastResumedAt
            },
            $inc: { resumeCount: -1 }
          }
        )
      }
      throw new AppError(409, 'STATE_CHANGED')
    }
    return { resumed: resumedDoc, seat: seatDoc }
  })

  track(changes, { seatId: seat._id, sessionId: resumed._id })
  const table = await LibraryTable.findById(resumed.tableId).lean()
  await audit.record({
    actor,
    action: 'entry.hold_resumed',
    studentId: resumed.studentId,
    sessionId: resumed._id,
    terminalCode: terminal.terminalCode,
    details: { seatCode: seat.seatCode, heldUntil: open.holdUntil }
  })
  return { outcome: 'hold_resumed', ...describe(resumed, seat, table) }
}

/**
 * Admits a student at an entry terminal: resumes a valid hold, or starts a new
 * visit on a seat chosen by table (deterministic lowest free seat) or by seat.
 */
async function admitStudent({ studentId, terminal, tableId, seatId, actor }, changes) {
  const now = clock.now()
  await loadEligibleStudent(studentId)
  await expireDueHolds({ studentId, now }, changes)

  const open = await LibrarySession.findOne({ studentId, isOpen: true })
  if (open && open.status === SESSION_STATUS.INSIDE) {
    await audit.record({
      actor,
      action: 'entry.rejected',
      outcome: 'rejected',
      studentId,
      sessionId: open._id,
      terminalCode: terminal.terminalCode,
      reason: 'DUPLICATE_ENTRY'
    })
    throw AppError.conflict('DUPLICATE_ENTRY')
  }
  if (open && open.status === SESSION_STATUS.HOLD) {
    return resumeHold(open, { terminal, actor, now }, changes)
  }

  // New visit: resolve the requested table/seat from the database, never from client state.
  let requestedSeat = null
  if (seatId) {
    requestedSeat = await Seat.findById(seatId).lean()
    if (!requestedSeat || !requestedSeat.isActive)
      throw AppError.conflict('SEAT_UNAVAILABLE').asRetryable()
    if (tableId && String(requestedSeat.tableId) !== String(tableId)) {
      throw AppError.badRequest(
        'VALIDATION_ERROR',
        'Seat does not belong to the selected table.'
      ).asRetryable()
    }
    tableId = requestedSeat.tableId
  }
  if (!tableId)
    throw AppError.badRequest('VALIDATION_ERROR', 'Choose a table or seat.').asRetryable()
  const table = await LibraryTable.findOne({ _id: tableId, isActive: true }).lean()
  if (!table) throw AppError.notFound('TABLE_NOT_FOUND').asRetryable()

  // Release any lapsed reservations on this table before deciding it is full.
  await expireDueHolds({ tableId: table._id, now }, changes)

  const { created, seat } = await withAtomic(async (session) => {
    let createdDoc
    try {
      ;[createdDoc] = await LibrarySession.create(
        [
          {
            studentId,
            entryTime: now,
            entryGateId: terminal.terminalCode,
            status: SESSION_STATUS.INSIDE,
            tableId: table._id
          }
        ],
        opts(session)
      )
    } catch (err) {
      if (isDuplicateKey(err)) throw AppError.conflict('DUPLICATE_ENTRY')
      throw err
    }

    const seatFilter = { tableId: table._id, isActive: true, status: SEAT_STATUS.AVAILABLE }
    if (requestedSeat) seatFilter._id = requestedSeat._id
    let seatDoc
    try {
      seatDoc = await Seat.findOneAndUpdate(
        seatFilter,
        {
          $set: {
            status: SEAT_STATUS.OCCUPIED,
            studentId,
            sessionId: createdDoc._id,
            reservedUntil: null
          }
        },
        opts(session, { ...AFTER, sort: { seatNumber: 1 } })
      )
    } catch (err) {
      if (!session) await LibrarySession.deleteOne({ _id: createdDoc._id })
      if (isDuplicateKey(err)) throw AppError.conflict('STATE_CHANGED')
      throw err
    }
    if (!seatDoc) {
      if (!session) await LibrarySession.deleteOne({ _id: createdDoc._id })
      throw AppError.conflict(requestedSeat ? 'SEAT_UNAVAILABLE' : 'TABLE_FULL').asRetryable()
    }
    createdDoc = await LibrarySession.findOneAndUpdate(
      { _id: createdDoc._id },
      { $set: { seatId: seatDoc._id } },
      opts(session, AFTER)
    )
    return { created: createdDoc, seat: seatDoc }
  })

  track(changes, { seatId: seat._id, sessionId: created._id })
  await audit.record({
    actor,
    action: 'entry.admitted',
    studentId,
    sessionId: created._id,
    terminalCode: terminal.terminalCode,
    details: { tableCode: table.tableCode, seatCode: seat.seatCode }
  })
  await audit.record({
    actor,
    action: 'seat.allocated',
    studentId,
    sessionId: created._id,
    terminalCode: terminal.terminalCode,
    details: { tableCode: table.tableCode, seatCode: seat.seatCode }
  })
  return { outcome: 'admitted', ...describe(created, seat, table) }
}

// ---------------------------------------------------------------------------
// Exit and hold
// ---------------------------------------------------------------------------

async function exitStudent({ studentId, terminal, mode, actor }, changes) {
  const now = clock.now()
  await expireDueHolds({ studentId, now }, changes)

  const open = await LibrarySession.findOne({ studentId, isOpen: true })
  const reject = async (code) => {
    await audit.record({
      actor,
      action: 'exit.rejected',
      outcome: 'rejected',
      studentId,
      sessionId: open?._id || null,
      terminalCode: terminal.terminalCode,
      reason: code
    })
    return AppError.conflict(code)
  }
  if (!open) throw await reject('NOT_INSIDE')
  if (open.status === SESSION_STATUS.HOLD) throw await reject('ALREADY_ON_HOLD')

  if (mode === EXIT_MODES.EXIT) {
    const result = await withAtomic(async (session) => {
      const closed = await LibrarySession.findOneAndUpdate(
        { _id: open._id, status: SESSION_STATUS.INSIDE },
        {
          $set: {
            status: SESSION_STATUS.COMPLETED,
            isOpen: false,
            exitTime: now,
            exitGateId: terminal.terminalCode,
            endedAt: now,
            endReason: 'exit'
          }
        },
        opts(session, AFTER)
      )
      if (!closed) return null
      // Conditional on sessionId: a seat is released at most once, by its own session.
      const seat = await Seat.findOneAndUpdate(
        { _id: closed.seatId, sessionId: closed._id },
        { $set: SEAT_RELEASE },
        opts(session, AFTER)
      )
      return { closed, seat }
    })
    if (!result) throw await reject('DUPLICATE_EXIT')

    const { closed, seat } = result
    track(changes, { seatId: closed.seatId, sessionId: closed._id })
    const table = await LibraryTable.findById(closed.tableId).lean()
    await audit.record({
      actor,
      action: 'exit.completed',
      studentId,
      sessionId: closed._id,
      terminalCode: terminal.terminalCode
    })
    if (seat) {
      await audit.record({
        actor,
        action: 'seat.released',
        studentId,
        sessionId: closed._id,
        terminalCode: terminal.terminalCode,
        reason: 'exit',
        details: { seatCode: seat.seatCode }
      })
    }
    return { outcome: 'exited', ...describe(closed, seat, table) }
  }

  if (mode === EXIT_MODES.HOLD) {
    const holdUntil = new Date(now.getTime() + HOLD_DURATION_MS)
    const result = await withAtomic(async (session) => {
      const held = await LibrarySession.findOneAndUpdate(
        { _id: open._id, status: SESSION_STATUS.INSIDE },
        {
          $set: {
            status: SESSION_STATUS.HOLD,
            exitTime: now,
            exitGateId: terminal.terminalCode,
            holdUntil
          }
        },
        opts(session, AFTER)
      )
      if (!held) return null
      const seat = await Seat.findOneAndUpdate(
        { _id: held.seatId, sessionId: held._id, status: SEAT_STATUS.OCCUPIED },
        { $set: { status: SEAT_STATUS.RESERVED, reservedUntil: holdUntil } },
        opts(session, AFTER)
      )
      if (!seat) {
        if (!session) {
          await LibrarySession.updateOne(
            { _id: held._id, status: SESSION_STATUS.HOLD },
            {
              $set: {
                status: SESSION_STATUS.INSIDE,
                exitTime: null,
                exitGateId: null,
                holdUntil: null
              }
            }
          )
        }
        throw new AppError(409, 'STATE_CHANGED')
      }
      return { held, seat }
    })
    if (!result) throw await reject('DUPLICATE_EXIT')

    const { held, seat } = result
    track(changes, { seatId: seat._id, sessionId: held._id })
    const table = await LibraryTable.findById(held.tableId).lean()
    await audit.record({
      actor,
      action: 'hold.created',
      studentId,
      sessionId: held._id,
      terminalCode: terminal.terminalCode,
      details: { seatCode: seat.seatCode, holdUntil }
    })
    return { outcome: 'hold_started', ...describe(held, seat, table) }
  }

  throw AppError.badRequest('VALIDATION_ERROR', 'Unknown exit mode.')
}

// ---------------------------------------------------------------------------
// Consistency repair (crash recovery on deployments without transactions)
// ---------------------------------------------------------------------------

/**
 * Restores the seat/session invariants documented in shared/libraryStates.mjs.
 * Only touches records untouched for RECONCILE_GRACE_MS so it never races a
 * request that is still in flight. Safe to run concurrently and repeatedly.
 */
async function reconcile({ now = clock.now() } = {}, changes) {
  const cutoff = new Date(now.getTime() - RECONCILE_GRACE_MS)
  let repaired = 0

  // 1. Open sessions without a seat link.
  const unlinked = await LibrarySession.find({
    isOpen: true,
    seatId: null,
    updatedAt: { $lte: cutoff }
  }).lean()
  for (const s of unlinked) {
    const seat = await Seat.findOne({ sessionId: s._id }).lean()
    if (seat) {
      await LibrarySession.updateOne({ _id: s._id, seatId: null }, { $set: { seatId: seat._id } })
    } else {
      await LibrarySession.updateOne(
        { _id: s._id, isOpen: true, seatId: null },
        {
          $set: {
            status: SESSION_STATUS.COMPLETED,
            isOpen: false,
            endedAt: now,
            endReason: 'reconciled'
          }
        }
      )
    }
    track(changes, { sessionId: s._id })
    repaired += 1
    await audit.record({
      actor: systemActor(),
      action: 'reconcile.session_repaired',
      outcome: 'info',
      studentId: s.studentId,
      sessionId: s._id,
      reason: seat ? 'linked_seat' : 'closed_without_seat'
    })
  }

  // 2. Non-available seats whose session is gone, closed, or points elsewhere.
  const held = await Seat.find({
    status: { $ne: SEAT_STATUS.AVAILABLE },
    updatedAt: { $lte: cutoff }
  }).lean()
  for (const seat of held) {
    const s = seat.sessionId ? await LibrarySession.findById(seat.sessionId).lean() : null
    const valid = s && s.isOpen && s.seatId && String(s.seatId) === String(seat._id)
    if (valid) {
      // Align seat status with session status if they drifted.
      const expected =
        s.status === SESSION_STATUS.HOLD ? SEAT_STATUS.RESERVED : SEAT_STATUS.OCCUPIED
      const expectedUntil = s.status === SESSION_STATUS.HOLD ? s.holdUntil : null
      if (
        seat.status !== expected ||
        String(seat.reservedUntil || '') !== String(expectedUntil || '')
      ) {
        await Seat.updateOne(
          { _id: seat._id, sessionId: s._id },
          { $set: { status: expected, reservedUntil: expectedUntil } }
        )
        track(changes, { seatId: seat._id })
        repaired += 1
      }
      continue
    }
    const res = await Seat.updateOne(
      { _id: seat._id, sessionId: seat.sessionId, status: seat.status },
      { $set: SEAT_RELEASE }
    )
    if (res.modifiedCount) {
      track(changes, { seatId: seat._id })
      repaired += 1
      await audit.record({
        actor: systemActor(),
        action: 'seat.released',
        outcome: 'info',
        studentId: seat.studentId,
        sessionId: seat.sessionId,
        reason: 'reconciled',
        details: { seatCode: seat.seatCode }
      })
    }
  }

  // 3. Open sessions whose seat no longer points back to them.
  const linked = await LibrarySession.find({
    isOpen: true,
    seatId: { $ne: null },
    updatedAt: { $lte: cutoff }
  }).lean()
  for (const s of linked) {
    const seat = await Seat.findById(s.seatId).lean()
    if (seat && String(seat.sessionId) === String(s._id)) continue
    const res = await LibrarySession.updateOne(
      { _id: s._id, isOpen: true },
      {
        $set: {
          status: SESSION_STATUS.COMPLETED,
          isOpen: false,
          endedAt: now,
          endReason: 'reconciled'
        }
      }
    )
    if (res.modifiedCount) {
      track(changes, { sessionId: s._id })
      repaired += 1
      await audit.record({
        actor: systemActor(),
        action: 'reconcile.session_repaired',
        outcome: 'info',
        studentId: s.studentId,
        sessionId: s._id,
        reason: 'seat_lost'
      })
    }
  }

  return repaired
}

module.exports = {
  newChanges,
  expireDueHolds,
  admitStudent,
  exitStudent,
  reconcile,
  RECONCILE_GRACE_MS
}
