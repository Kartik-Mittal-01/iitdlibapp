// Staff/admin operations: terminals, cards, tables, students, and read-only listings.
const mongoose = require('mongoose')
const {
  GateTerminal,
  RFIDCard,
  Student,
  LibraryTable,
  Seat,
  LibrarySession,
  AuditLog
} = require('../models')
const audit = require('./auditService')
const AppError = require('../utils/AppError')
const { randomToken, sha256, hashCardUid, normalizeCardUid } = require('../utils/crypto')
const { paginated } = require('../utils/http')
const { SEAT_STATUS } = require('../shared')

function staffActor(principal) {
  return principal ? { type: 'staff', id: principal.id } : null
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dateRange(from, to) {
  if (!from && !to) return undefined
  const range = {}
  if (from) range.$gte = new Date(from)
  if (to) range.$lte = new Date(to)
  return range
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

/** Creates a terminal and returns its key. The key is shown exactly once. */
async function createTerminal({ terminalCode, gateType, name }, principal) {
  const key = randomToken(32)
  let terminal
  try {
    terminal = await GateTerminal.create({
      terminalCode,
      gateType,
      name,
      credentialHash: sha256(key)
    })
  } catch (err) {
    if (err.code === 11000)
      throw AppError.conflict('DUPLICATE_TERMINAL', 'Terminal code already exists.')
    throw err
  }
  await audit.record({
    actor: staffActor(principal),
    action: 'admin.terminal_created',
    terminalCode: terminal.terminalCode,
    details: { gateType }
  })
  return { terminal: terminal.toJSON(), terminalKey: key }
}

async function rotateTerminalKey(terminalId, principal) {
  const key = randomToken(32)
  const terminal = await GateTerminal.findByIdAndUpdate(
    terminalId,
    {
      $set: { credentialHash: sha256(key), credentialRotatedAt: new Date() },
      $inc: { credentialVersion: 1 }
    },
    { returnDocument: 'after' }
  )
  if (!terminal) throw AppError.notFound()
  await audit.record({
    actor: staffActor(principal),
    action: 'admin.terminal_key_rotated',
    terminalCode: terminal.terminalCode
  })
  return { terminal: terminal.toJSON(), terminalKey: key }
}

async function listTerminals() {
  return GateTerminal.find().sort({ terminalCode: 1 }).lean()
}

async function updateTerminal(terminalId, changes, principal) {
  const terminal = await GateTerminal.findByIdAndUpdate(
    terminalId,
    { $set: changes },
    { returnDocument: 'after', runValidators: true }
  )
  if (!terminal) throw AppError.notFound()
  await audit.record({
    actor: staffActor(principal),
    action: 'admin.terminal_updated',
    terminalCode: terminal.terminalCode,
    details: changes
  })
  return terminal.toJSON()
}

// ---------------------------------------------------------------------------
// RFID cards
// ---------------------------------------------------------------------------

async function registerCard({ entryNumber, cardUid, replaceExisting }, principal) {
  const student = await Student.findOne({ entryNumber: entryNumber.toUpperCase() })
  if (!student) throw AppError.notFound('NOT_FOUND', 'No student with that entry number.')
  const normalized = normalizeCardUid(cardUid)
  if (!/^[0-9A-F]{8,32}$/.test(normalized)) {
    throw AppError.badRequest('VALIDATION_ERROR', 'Card UID must be 4–16 bytes of hex.')
  }
  const cardUidHash = hashCardUid(normalized)
  if (await RFIDCard.exists({ cardUidHash })) {
    throw AppError.conflict('DUPLICATE_CARD', 'This card is already registered.')
  }
  const current = await RFIDCard.findOne({ studentId: student._id, isActive: true })
  if (current) {
    if (!replaceExisting) {
      throw AppError.conflict(
        'CARD_EXISTS',
        'Student already has an active card. Revoke it or replace it.'
      )
    }
    await revokeCard(current._id, 'replaced', principal)
  }
  let card
  try {
    card = await RFIDCard.create({
      cardUidHash,
      cardUidHint: normalized.slice(-4),
      studentId: student._id
    })
  } catch (err) {
    if (err.code === 11000)
      throw AppError.conflict('DUPLICATE_CARD', 'This card is already registered.')
    throw err
  }
  await audit.record({
    actor: staffActor(principal),
    action: 'admin.card_issued',
    studentId: student._id,
    details: { cardId: card._id, hint: card.cardUidHint }
  })
  return card.toJSON()
}

async function revokeCard(cardId, reason, principal) {
  const card = await RFIDCard.findOneAndUpdate(
    { _id: cardId, isActive: true },
    { $set: { isActive: false, revokedAt: new Date(), revokedReason: reason || null } },
    { returnDocument: 'after' }
  )
  if (!card) throw AppError.notFound('NOT_FOUND', 'No active card with that id.')
  await audit.record({
    actor: staffActor(principal),
    action: 'admin.card_revoked',
    studentId: card.studentId,
    reason: reason || null,
    details: { cardId: card._id, hint: card.cardUidHint }
  })
  return card.toJSON()
}

async function listCards({ entryNumber, isActive }, pg) {
  const filter = {}
  if (entryNumber) {
    const s = await Student.findOne({ entryNumber: entryNumber.toUpperCase() }).select('_id').lean()
    filter.studentId = s ? s._id : new mongoose.Types.ObjectId()
  }
  if (isActive !== undefined) filter.isActive = isActive
  const [items, total] = await Promise.all([
    RFIDCard.find(filter)
      .sort({ createdAt: -1 })
      .skip(pg.skip)
      .limit(pg.limit)
      .populate('studentId', 'entryNumber name'),
    RFIDCard.countDocuments(filter)
  ])
  return paginated(
    items.map((c) => c.toJSON()),
    total,
    pg
  )
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

async function listStudents({ q, isActive }, pg) {
  const filter = {}
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i')
    filter.$or = [{ entryNumber: rx }, { name: rx }, { email: rx }]
  }
  if (isActive !== undefined) filter.isActive = isActive
  const [items, total] = await Promise.all([
    Student.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit),
    Student.countDocuments(filter)
  ])
  return paginated(
    items.map((s) => s.toJSON()),
    total,
    pg
  )
}

async function updateStudent(studentId, changes, principal) {
  const student = await Student.findByIdAndUpdate(
    studentId,
    { $set: changes },
    { returnDocument: 'after', runValidators: true }
  )
  if (!student) throw AppError.notFound()
  await audit.record({
    actor: staffActor(principal),
    action: 'admin.student_updated',
    studentId: student._id,
    details: changes
  })
  return student.toJSON()
}

// ---------------------------------------------------------------------------
// Sessions and logs
// ---------------------------------------------------------------------------

async function resolveStudentFilter(entryNumber, studentId) {
  if (studentId) return studentId
  if (!entryNumber) return undefined
  const s = await Student.findOne({ entryNumber: entryNumber.toUpperCase() }).select('_id').lean()
  return s ? s._id : new mongoose.Types.ObjectId() // no match -> empty result
}

async function listSessions({ status, studentId, entryNumber, from, to }, pg) {
  const filter = {}
  if (status) filter.status = status
  const sid = await resolveStudentFilter(entryNumber, studentId)
  if (sid) filter.studentId = sid
  const range = dateRange(from, to)
  if (range) filter.entryTime = range
  const [items, total] = await Promise.all([
    LibrarySession.find(filter)
      .sort({ entryTime: -1 })
      .skip(pg.skip)
      .limit(pg.limit)
      .populate('studentId', 'entryNumber name')
      .populate('seatId', 'seatCode')
      .populate('tableId', 'tableCode name')
      .lean(),
    LibrarySession.countDocuments(filter)
  ])
  return paginated(items, total, pg)
}

async function listLogs(
  { action, outcome, actorType, terminalCode, studentId, entryNumber, from, to },
  pg
) {
  const filter = {}
  if (action)
    filter.action = action.endsWith('*')
      ? new RegExp(`^${escapeRegex(action.slice(0, -1))}`)
      : action
  if (outcome) filter.outcome = outcome
  if (actorType) filter.actorType = actorType
  if (terminalCode) filter.terminalCode = terminalCode.toUpperCase()
  const sid = await resolveStudentFilter(entryNumber, studentId)
  if (sid) filter.studentId = sid
  const range = dateRange(from, to)
  if (range) filter.createdAt = range
  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(pg.skip)
      .limit(pg.limit)
      .populate('studentId', 'entryNumber name')
      .lean(),
    AuditLog.countDocuments(filter)
  ])
  return paginated(items, total, pg)
}

// ---------------------------------------------------------------------------
// Tables and seats
// ---------------------------------------------------------------------------

/** Places `capacity` seats around a table rectangle: top row first, then bottom row. */
function layoutSeats(location, capacity) {
  const top = Math.ceil(capacity / 2)
  const bottom = capacity - top
  const positions = []
  const offset = 16
  for (let i = 0; i < top; i += 1) {
    positions.push({
      x: Math.round(location.x + ((i + 0.5) * location.width) / top),
      y: Math.round(location.y - offset)
    })
  }
  for (let i = 0; i < bottom; i += 1) {
    positions.push({
      x: Math.round(location.x + ((i + 0.5) * location.width) / bottom),
      y: Math.round(location.y + location.height + offset)
    })
  }
  return positions
}

function seatDocs(table, fromNumber, toNumber) {
  const positions = layoutSeats(table.location, table.capacity)
  const docs = []
  for (let n = fromNumber; n <= toNumber; n += 1) {
    docs.push({
      seatCode: `${table.tableCode}-S${n}`,
      tableId: table._id,
      seatNumber: n,
      position: positions[n - 1]
    })
  }
  return docs
}

async function createTable({ tableCode, name, capacity, location }, principal) {
  let table
  try {
    table = await LibraryTable.create({ tableCode, name, capacity, location })
  } catch (err) {
    if (err.code === 11000) throw AppError.conflict('DUPLICATE_TABLE', 'Table code already exists.')
    throw err
  }
  try {
    await Seat.insertMany(seatDocs(table, 1, capacity))
  } catch (err) {
    await LibraryTable.deleteOne({ _id: table._id })
    await Seat.deleteMany({ tableId: table._id })
    throw err
  }
  await audit.record({
    actor: staffActor(principal),
    action: 'admin.table_created',
    details: { tableCode: table.tableCode, capacity }
  })
  return table.toJSON()
}

/**
 * Updates a table. Capacity can grow freely; it can shrink only when the seats
 * being removed are free, so an occupied/reserved seat is never deleted.
 */
async function updateTable(tableId, changes, principal) {
  const table = await LibraryTable.findById(tableId)
  if (!table) throw AppError.notFound('TABLE_NOT_FOUND')
  const oldCapacity = table.capacity
  const { capacity, ...rest } = changes
  if (rest.isActive === false && table.isActive) {
    const inUse = await Seat.exists({ tableId, status: { $ne: SEAT_STATUS.AVAILABLE } })
    if (inUse)
      throw AppError.conflict(
        'SEATS_IN_USE',
        'Cannot deactivate a table with occupied or reserved seats.'
      )
  }
  Object.assign(table, rest)
  if (capacity !== undefined && capacity !== oldCapacity) {
    if (capacity < oldCapacity) {
      const removed = await Seat.find({ tableId, seatNumber: { $gt: capacity } }).lean()
      if (removed.some((s) => s.status !== SEAT_STATUS.AVAILABLE)) {
        throw AppError.conflict(
          'SEATS_IN_USE',
          'Cannot remove seats that are occupied or reserved.'
        )
      }
      const res = await Seat.deleteMany({
        tableId,
        seatNumber: { $gt: capacity },
        status: SEAT_STATUS.AVAILABLE
      })
      if (res.deletedCount !== removed.length) {
        throw AppError.conflict('SEATS_IN_USE', 'A seat was taken while resizing; try again.')
      }
    }
    table.capacity = capacity
  }
  await table.save()
  // Re-layout seat positions (and add new seats) to match the table geometry.
  const positions = layoutSeats(table.location, table.capacity)
  const existing = await Seat.find({ tableId }).select('seatNumber').lean()
  const have = new Set(existing.map((s) => s.seatNumber))
  await Promise.all(
    existing.map((s) =>
      Seat.updateOne({ _id: s._id }, { $set: { position: positions[s.seatNumber - 1] } })
    )
  )
  const missing = seatDocs(table, 1, table.capacity).filter((d) => !have.has(d.seatNumber))
  if (missing.length) await Seat.insertMany(missing)

  await audit.record({
    actor: staffActor(principal),
    action: 'admin.table_updated',
    details: { tableCode: table.tableCode, ...changes }
  })
  return table.toJSON()
}

module.exports = {
  createTerminal,
  rotateTerminalKey,
  listTerminals,
  updateTerminal,
  registerCard,
  revokeCard,
  listCards,
  listStudents,
  updateStudent,
  listSessions,
  listLogs,
  createTable,
  updateTable,
  layoutSeats
}
