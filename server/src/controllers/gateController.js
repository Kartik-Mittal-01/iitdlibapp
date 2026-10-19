const gateService = require('../services/gateService')
const visitService = require('../services/visitService')
const authService = require('../services/authService')
const publisher = require('../realtime/publisher')
const { Student } = require('../models')
const AppError = require('../utils/AppError')
const { ok } = require('../utils/http')

// Runs a state-changing operation and broadcasts whatever committed, whether
// or not the operation as a whole succeeded (e.g. a lazily expired hold).
async function withChanges(fn) {
  const changes = visitService.newChanges()
  try {
    return await fn(changes)
  } finally {
    // publish() never throws; awaiting keeps broadcasts ordered before the response.
    await publisher.publish(changes)
  }
}

function terminalOf(req) {
  return req.principal.doc
}

async function terminalToken(req, res) {
  const terminal = terminalOf(req)
  const { token, expiresAt } = authService.issueTerminalToken(terminal)
  ok(res, {
    token,
    expiresAt,
    terminal: {
      terminalCode: terminal.terminalCode,
      gateType: terminal.gateType,
      name: terminal.name
    }
  })
}

async function terminalMe(req, res) {
  const t = terminalOf(req)
  ok(res, { terminal: { terminalCode: t.terminalCode, gateType: t.gateType, name: t.name } })
}

async function scan(req, res) {
  const { cardUid, requestId } = req.valid.body
  const { httpStatus, body } = await withChanges((changes) =>
    gateService.processScan({ terminal: terminalOf(req), cardUid, requestId }, changes)
  )
  res.status(httpStatus).json(body)
}

async function entry(req, res) {
  const { scanToken, tableId, seatId } = req.valid.body
  const result = await withChanges((changes) =>
    gateService.completeEntry({ terminal: terminalOf(req), scanToken, tableId, seatId }, changes)
  )
  ok(res, result, result.replayed ? 200 : 201)
}

async function exit(req, res) {
  const { scanToken, mode } = req.valid.body
  const result = await withChanges((changes) =>
    gateService.completeExit({ terminal: terminalOf(req), scanToken, mode }, changes)
  )
  ok(res, result)
}

async function status(req, res) {
  const entryNumber = req.valid.params.entryNumber.toUpperCase()
  const p = req.principal
  if (p.type === 'student' && p.doc.entryNumber !== entryNumber) throw AppError.forbidden()
  const student = p.type === 'student' ? p.doc : await Student.findOne({ entryNumber })
  if (!student) throw AppError.notFound()
  ok(res, await withChanges((changes) => gateService.getStudentStatus(student, changes)))
}

module.exports = { terminalToken, terminalMe, scan, entry, exit, status, withChanges }
