const mapService = require('../services/mapService')
const visitService = require('../services/visitService')
const { GateTerminal, Student } = require('../models')
const AppError = require('../utils/AppError')
const { ok } = require('../utils/http')
const { withChanges } = require('./gateController')
const { GATE_TYPES } = require('../shared')

async function map(_req, res) {
  ok(res, await withChanges((changes) => mapService.getMap(changes)))
}

async function occupancy(_req, res) {
  await withChanges((changes) => visitService.expireDueHolds({}, changes))
  ok(res, await mapService.getOccupancy())
}

async function tables(_req, res) {
  ok(res, { tables: await withChanges((changes) => mapService.listTables(changes)) })
}

async function tableSeats(req, res) {
  ok(
    res,
    await withChanges((changes) => mapService.getTableSeats(req.valid.params.tableId, changes))
  )
}

/**
 * Staff-assisted admission (e.g. a student whose card is lost or a reader that
 * is down). Uses exactly the same service as card-based entry, attributed to
 * the staff member and recorded against the named entry terminal.
 */
async function allocateSeat(req, res) {
  const { entryNumber, terminalCode, tableId, seatId } = req.valid.body
  const terminal = await GateTerminal.findOne({
    terminalCode: terminalCode.toUpperCase(),
    gateType: GATE_TYPES.ENTRY,
    isActive: true
  })
  if (!terminal)
    throw AppError.badRequest('VALIDATION_ERROR', 'Unknown or inactive entry terminal.')
  const student = await Student.findOne({ entryNumber: entryNumber.toUpperCase() })
  if (!student) throw AppError.notFound('NOT_FOUND', 'No student with that entry number.')
  const result = await withChanges((changes) =>
    visitService.admitStudent(
      { studentId: student._id, terminal, tableId, seatId, actor: req.principal },
      changes
    )
  )
  ok(res, result, 201)
}

module.exports = { map, occupancy, tables, tableSeats, allocateSeat }
