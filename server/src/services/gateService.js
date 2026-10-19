// Gate workflow on top of visitService:
//
//   1. POST /api/gate/scan   (terminal-authenticated; usually the ESP32)
//      The server resolves card -> student, checks eligibility against the
//      registered gate type, and issues a short-lived single-use scan token.
//      The result (with token) is pushed to the gate's kiosk as gate:result.
//   2. POST /api/gate/entry | /api/gate/exit   (same terminal; the kiosk)
//      The kiosk presents the scan token plus the student's choice
//      (table/seat, or exit/hold). The student identity always comes from the
//      server-side scan record, never from the kiosk.
//
// Idempotency: a device may send `requestId`; a retried scan with the same id
// replays the stored response. A retried entry/exit with an already-consumed
// token replays the stored result instead of acting twice.

const { GateScan, RFIDCard, Student, LibrarySession, Seat } = require('../models')
const visitService = require('./visitService')
const audit = require('./auditService')
const clock = require('./clock')
const publisher = require('../realtime/publisher')
const AppError = require('../utils/AppError')
const { config } = require('../config/env')
const { randomToken, sha256, hashCardUid } = require('../utils/crypto')
const {
  GATE_TYPES,
  GATE_NEXT_ACTION,
  SESSION_STATUS,
  SEAT_STATUS,
  EXIT_MODES,
  HOLD_DURATION_MS,
  errorMessage
} = require('../shared')

function maskEntryNumber(entryNumber) {
  if (!entryNumber || entryNumber.length < 6) return '****'
  return `${entryNumber.slice(0, 4)}${'*'.repeat(entryNumber.length - 6)}${entryNumber.slice(-2)}`
}

// Only what a public gate screen needs: first name and a masked entry number.
function gateStudent(student) {
  if (!student) return null
  return {
    displayName: student.name.split(/\s+/)[0],
    entryNumberMasked: maskEntryNumber(student.entryNumber)
  }
}

function terminalActor(terminal) {
  return { type: 'terminal', id: terminal._id }
}

async function visitSummary(open) {
  if (!open) return null
  const seat = open.seatId ? await Seat.findById(open.seatId).populate('tableId').lean() : null
  return {
    status: open.status,
    entryTime: open.entryTime,
    holdUntil: open.holdUntil,
    seatCode: seat?.seatCode || null,
    tableCode: seat?.tableId?.tableCode || null,
    tableName: seat?.tableId?.name || null
  }
}

async function storeScanRecord(doc) {
  try {
    return await GateScan.create(doc)
  } catch (err) {
    if (err.code === 11000 && doc.requestId) {
      // Concurrent retry of the same device request: the first one wins.
      return null
    }
    throw err
  }
}

function replayStored(existing) {
  const body = existing.response || { success: false, error: { code: 'SCAN_EXPIRED' } }
  const replayed = body.data ? { ...body, data: { ...body.data, replayed: true } } : body
  return { httpStatus: existing.httpStatus || 200, body: replayed }
}

/**
 * Handles a card scan from an authenticated terminal.
 * @returns {Promise<{httpStatus:number, body:object}>}
 */
async function processScan({ terminal, cardUid, requestId }, changes) {
  const now = clock.now()

  if (requestId) {
    const existing = await GateScan.findOne({ terminalId: terminal._id, requestId })
    if (existing) return replayStored(existing)
  }

  const card = await RFIDCard.findOne({ cardUidHash: hashCardUid(cardUid) })
  let student = null
  let open = null
  let rejection = null
  let nextAction = null

  if (!card) rejection = { status: 403, code: 'UNKNOWN_CARD' }
  else if (!card.isActive) rejection = { status: 403, code: 'CARD_REVOKED' }
  else {
    student = await Student.findById(card.studentId)
    if (!student || !student.isActive) rejection = { status: 403, code: 'STUDENT_INACTIVE' }
  }

  if (!rejection) {
    await visitService.expireDueHolds({ studentId: student._id, now }, changes)
    open = await LibrarySession.findOne({ studentId: student._id, isOpen: true })
    if (terminal.gateType === GATE_TYPES.ENTRY) {
      if (open?.status === SESSION_STATUS.INSIDE)
        rejection = { status: 409, code: 'DUPLICATE_ENTRY' }
      else if (open?.status === SESSION_STATUS.HOLD) nextAction = GATE_NEXT_ACTION.RESUME_HOLD
      else {
        await visitService.expireDueHolds({ now }, changes)
        const free = await Seat.exists({ status: SEAT_STATUS.AVAILABLE, isActive: true })
        if (!free) rejection = { status: 409, code: 'LIBRARY_FULL' }
        else nextAction = GATE_NEXT_ACTION.SELECT_SEAT
      }
    } else {
      if (open?.status === SESSION_STATUS.INSIDE) nextAction = GATE_NEXT_ACTION.CHOOSE_EXIT
      else if (open?.status === SESSION_STATUS.HOLD)
        rejection = { status: 409, code: 'ALREADY_ON_HOLD' }
      else rejection = { status: 409, code: 'NOT_INSIDE' }
    }
  }

  const base = {
    stage: 'scan',
    terminalCode: terminal.terminalCode,
    gateType: terminal.gateType,
    scannedAt: now,
    serverTime: now,
    student: gateStudent(student)
  }

  if (rejection) {
    const payload = {
      ...base,
      accepted: false,
      code: rejection.code,
      message: errorMessage(rejection.code),
      visit: rejection.code === 'ALREADY_ON_HOLD' ? await visitSummary(open) : null
    }
    const body = {
      success: false,
      error: { code: rejection.code, message: payload.message, details: payload }
    }
    const stored = await storeScanRecord({
      terminalId: terminal._id,
      terminalCode: terminal.terminalCode,
      gateType: terminal.gateType,
      requestId: requestId || null,
      studentId: student?._id || null,
      cardId: card?._id || null,
      status: 'rejected',
      expiresAt: now,
      httpStatus: rejection.status,
      response: body
    })
    if (!stored)
      return replayStored(await GateScan.findOne({ terminalId: terminal._id, requestId }))

    await audit.record({
      actor: terminalActor(terminal),
      action:
        rejection.code === 'DUPLICATE_ENTRY' ? 'gate.scan.duplicate_entry' : 'gate.scan.rejected',
      outcome: 'rejected',
      studentId: student?._id || null,
      sessionId: open?._id || null,
      terminalCode: terminal.terminalCode,
      reason: rejection.code,
      details: { cardId: card?._id || null }
    })
    publisher.emitGateResult(terminal.terminalCode, payload)
    return { httpStatus: rejection.status, body }
  }

  // Accepted: only the newest scan at a terminal is actionable.
  await GateScan.updateMany(
    { terminalId: terminal._id, status: 'pending' },
    { $set: { status: 'superseded' } }
  )
  const token = randomToken()
  const expiresAt = new Date(now.getTime() + config.scanTokenTtlSeconds * 1000)
  const payload = {
    ...base,
    accepted: true,
    nextAction,
    expiresAt,
    visit: await visitSummary(open),
    exitOptions:
      nextAction === GATE_NEXT_ACTION.CHOOSE_EXIT ? [EXIT_MODES.EXIT, EXIT_MODES.HOLD] : undefined,
    holdDurationMinutes: HOLD_DURATION_MS / 60000
  }
  const stored = await storeScanRecord({
    tokenHash: sha256(token),
    terminalId: terminal._id,
    terminalCode: terminal.terminalCode,
    gateType: terminal.gateType,
    requestId: requestId || null,
    studentId: student._id,
    cardId: card._id,
    status: 'pending',
    nextAction,
    expiresAt,
    httpStatus: 200,
    // The token itself is never stored in plaintext, so replays omit it.
    response: { success: true, data: payload }
  })
  if (!stored) return replayStored(await GateScan.findOne({ terminalId: terminal._id, requestId }))

  await audit.record({
    actor: terminalActor(terminal),
    action: 'gate.scan.accepted',
    outcome: 'info',
    studentId: student._id,
    sessionId: open?._id || null,
    terminalCode: terminal.terminalCode,
    details: { nextAction }
  })
  const withToken = { ...payload, scanToken: token }
  publisher.emitGateResult(terminal.terminalCode, withToken)
  return { httpStatus: 200, body: { success: true, data: withToken } }
}

/**
 * Atomically moves a pending scan to "processing" so that two requests with
 * the same token can never both act. Returns { scan } or { replay }.
 */
async function claimScan({ terminal, scanToken, gateType }) {
  const now = clock.now()
  const tokenHash = sha256(scanToken)
  const scan = await GateScan.findOneAndUpdate(
    { tokenHash, terminalId: terminal._id, gateType, status: 'pending', expiresAt: { $gt: now } },
    { $set: { status: 'processing' } },
    { returnDocument: 'after' }
  )
  if (scan) return { scan }

  const existing = await GateScan.findOne({ tokenHash })
  if (!existing) throw AppError.gone('SCAN_EXPIRED')
  if (String(existing.terminalId) !== String(terminal._id) || existing.gateType !== gateType) {
    throw AppError.forbidden('SCAN_WRONG_GATE')
  }
  if (existing.status === 'consumed' && existing.result) return { replay: existing.result }
  if (existing.status === 'processing' && existing.expiresAt > now) {
    throw AppError.conflict('SCAN_IN_PROGRESS')
  }
  throw AppError.gone('SCAN_EXPIRED')
}

async function settleScan(scan, err, result) {
  if (!err) {
    await GateScan.updateOne(
      { _id: scan._id, status: 'processing' },
      { $set: { status: 'consumed', result } }
    )
    return
  }
  // Retryable failures (seat just taken, table full...) keep the scan usable.
  const status = err instanceof AppError && err.retryable ? 'pending' : 'rejected'
  await GateScan.updateOne({ _id: scan._id, status: 'processing' }, { $set: { status } })
}

async function assertCardStillValid(scan) {
  const card = await RFIDCard.findById(scan.cardId).lean()
  if (!card || !card.isActive) throw AppError.forbidden('CARD_REVOKED')
}

async function completeEntry({ terminal, scanToken, tableId, seatId }, changes) {
  if (terminal.gateType !== GATE_TYPES.ENTRY) throw AppError.forbidden('SCAN_WRONG_GATE')
  const claim = await claimScan({ terminal, scanToken, gateType: GATE_TYPES.ENTRY })
  if (claim.replay) return { ...claim.replay, replayed: true }
  const { scan } = claim
  try {
    await assertCardStillValid(scan)
    const result = await visitService.admitStudent(
      { studentId: scan.studentId, terminal, tableId, seatId, actor: terminalActor(terminal) },
      changes
    )
    const student = await Student.findById(scan.studentId).lean()
    const out = {
      stage: 'completed',
      ...result,
      student: gateStudent(student),
      serverTime: clock.now()
    }
    await settleScan(scan, null, out)
    publisher.emitGateResult(terminal.terminalCode, out)
    return out
  } catch (err) {
    await settleScan(scan, err)
    throw err
  }
}

async function completeExit({ terminal, scanToken, mode }, changes) {
  if (terminal.gateType !== GATE_TYPES.EXIT) throw AppError.forbidden('SCAN_WRONG_GATE')
  const claim = await claimScan({ terminal, scanToken, gateType: GATE_TYPES.EXIT })
  if (claim.replay) return { ...claim.replay, replayed: true }
  const { scan } = claim
  try {
    // A revoked card may still leave the building; exit is not blocked on card status.
    const result = await visitService.exitStudent(
      { studentId: scan.studentId, terminal, mode, actor: terminalActor(terminal) },
      changes
    )
    const student = await Student.findById(scan.studentId).lean()
    const out = {
      stage: 'completed',
      ...result,
      student: gateStudent(student),
      serverTime: clock.now()
    }
    await settleScan(scan, null, out)
    publisher.emitGateResult(terminal.terminalCode, out)
    return out
  } catch (err) {
    await settleScan(scan, err)
    throw err
  }
}

/** Current visit state for one student (student themselves or staff). */
async function getStudentStatus(student, changes) {
  const now = clock.now()
  await visitService.expireDueHolds({ studentId: student._id, now }, changes)
  const open = await LibrarySession.findOne({ studentId: student._id, isOpen: true }).lean()
  return {
    entryNumber: student.entryNumber,
    state: open ? open.status : 'outside',
    visit: await visitSummary(open),
    serverTime: now
  }
}

module.exports = {
  processScan,
  completeEntry,
  completeExit,
  getStudentStatus,
  gateStudent,
  maskEntryNumber
}
