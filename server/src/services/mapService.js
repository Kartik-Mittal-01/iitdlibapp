const mongoose = require('mongoose')
const { LibraryTable, Seat, LibrarySession } = require('../models')
const visitService = require('./visitService')
const clock = require('./clock')
const AppError = require('../utils/AppError')
const { MAP_CANVAS, MAP_LEGEND, SEAT_STATUS, SESSION_STATUS } = require('../shared')

// Public seat view: never includes who is sitting there.
function seatView(seat) {
  return {
    id: String(seat._id),
    seatCode: seat.seatCode,
    seatNumber: seat.seatNumber,
    tableId: String(seat.tableId),
    position: seat.position,
    status: seat.status,
    reservedUntil: seat.status === SEAT_STATUS.RESERVED ? seat.reservedUntil : null,
    isActive: seat.isActive
  }
}

function tableView(table, seats) {
  const counts = { available: 0, occupied: 0, reserved: 0 }
  for (const s of seats) counts[s.status] += 1
  return {
    id: String(table._id),
    tableCode: table.tableCode,
    name: table.name,
    capacity: table.capacity,
    location: table.location,
    counts,
    seats: seats.map(seatView)
  }
}

async function activeTablesWithSeats() {
  const tables = await LibraryTable.find({ isActive: true }).sort({ tableCode: 1 }).lean()
  const seats = await Seat.find({ tableId: { $in: tables.map((t) => t._id) }, isActive: true })
    .sort({ seatNumber: 1 })
    .lean()
  const byTable = new Map(tables.map((t) => [String(t._id), []]))
  for (const s of seats) byTable.get(String(s.tableId))?.push(s)
  return tables.map((t) => tableView(t, byTable.get(String(t._id))))
}

async function getOccupancy() {
  const activeTableIds = await LibraryTable.find({ isActive: true }).distinct('_id')
  const rows = await Seat.aggregate([
    { $match: { tableId: { $in: activeTableIds }, isActive: true } },
    { $group: { _id: '$status', n: { $sum: 1 } } }
  ])
  const counts = { available: 0, occupied: 0, reserved: 0 }
  for (const r of rows) counts[r._id] = r.n
  const [inside, onHold] = await Promise.all([
    LibrarySession.countDocuments({ status: SESSION_STATUS.INSIDE }),
    LibrarySession.countDocuments({ status: SESSION_STATUS.HOLD })
  ])
  return {
    capacity: counts.available + counts.occupied + counts.reserved,
    ...counts,
    studentsInside: inside,
    studentsOnHold: onHold,
    serverTime: clock.now()
  }
}

async function getMap(changes) {
  await visitService.expireDueHolds({ now: clock.now() }, changes)
  const [tables, occupancy] = await Promise.all([activeTablesWithSeats(), getOccupancy()])
  return { canvas: MAP_CANVAS, legend: MAP_LEGEND, tables, occupancy, serverTime: clock.now() }
}

async function listTables(changes) {
  await visitService.expireDueHolds({ now: clock.now() }, changes)
  const tables = await activeTablesWithSeats()
  return tables.map(({ seats: _seats, ...t }) => t)
}

async function getTableSeats(tableId, changes) {
  if (!mongoose.isValidObjectId(tableId)) throw AppError.notFound('TABLE_NOT_FOUND')
  const table = await LibraryTable.findOne({ _id: tableId, isActive: true }).lean()
  if (!table) throw AppError.notFound('TABLE_NOT_FOUND')
  await visitService.expireDueHolds({ tableId: table._id, now: clock.now() }, changes)
  const seats = await Seat.find({ tableId: table._id, isActive: true })
    .sort({ seatNumber: 1 })
    .lean()
  return { ...tableView(table, seats), serverTime: clock.now() }
}

async function getSeatStates(seatIds) {
  const seats = await Seat.find({ _id: { $in: seatIds } }).lean()
  return seats.map(seatView)
}

async function getSessionSummaries(sessionIds) {
  const sessions = await LibrarySession.find({ _id: { $in: sessionIds } })
    .populate('seatId', 'seatCode')
    .populate('tableId', 'tableCode name')
    .lean()
  return sessions.map((s) => ({
    id: String(s._id),
    studentId: String(s.studentId),
    status: s.status,
    entryTime: s.entryTime,
    exitTime: s.exitTime,
    holdUntil: s.holdUntil,
    endReason: s.endReason,
    seatCode: s.seatId?.seatCode || null,
    tableCode: s.tableId?.tableCode || null
  }))
}

module.exports = {
  getMap,
  getOccupancy,
  listTables,
  getTableSeats,
  getSeatStates,
  getSessionSummaries
}
