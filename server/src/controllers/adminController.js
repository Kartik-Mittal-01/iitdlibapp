const adminService = require('../services/adminService')
const publisher = require('../realtime/publisher')
const { ok, parsePagination } = require('../utils/http')

async function logs(req, res) {
  ok(res, await adminService.listLogs(req.valid.query, parsePagination(req.valid.query)))
}

async function students(req, res) {
  ok(res, await adminService.listStudents(req.valid.query, parsePagination(req.valid.query)))
}

async function updateStudent(req, res) {
  ok(
    res,
    await adminService.updateStudent(req.valid.params.studentId, req.valid.body, req.principal)
  )
}

async function sessions(req, res) {
  ok(res, await adminService.listSessions(req.valid.query, parsePagination(req.valid.query)))
}

async function terminals(_req, res) {
  ok(res, { items: await adminService.listTerminals() })
}

async function createTerminal(req, res) {
  ok(res, await adminService.createTerminal(req.valid.body, req.principal), 201)
}

async function updateTerminal(req, res) {
  ok(
    res,
    await adminService.updateTerminal(req.valid.params.terminalId, req.valid.body, req.principal)
  )
}

async function rotateTerminalKey(req, res) {
  ok(res, await adminService.rotateTerminalKey(req.valid.params.terminalId, req.principal))
}

async function cards(req, res) {
  ok(res, await adminService.listCards(req.valid.query, parsePagination(req.valid.query)))
}

async function registerCard(req, res) {
  ok(res, await adminService.registerCard(req.valid.body, req.principal), 201)
}

async function revokeCard(req, res) {
  ok(
    res,
    await adminService.revokeCard(req.valid.params.cardId, req.valid.body.reason, req.principal)
  )
}

async function createTable(req, res) {
  const table = await adminService.createTable(req.valid.body, req.principal)
  publisher.publishMapReload()
  ok(res, table, 201)
}

async function updateTable(req, res) {
  const table = await adminService.updateTable(
    req.valid.params.tableId,
    req.valid.body,
    req.principal
  )
  // Seats may have been added or removed, so clients refetch the whole map.
  publisher.publishMapReload()
  ok(res, table)
}

module.exports = {
  logs,
  students,
  updateStudent,
  sessions,
  terminals,
  createTerminal,
  updateTerminal,
  rotateTerminalKey,
  cards,
  registerCard,
  revokeCard,
  createTable,
  updateTable
}
