#!/usr/bin/env node
// Seeds the library floor plan (tables + seats) from the reference layout in
// shared/libraryLayout.mjs (recreated from librarymap.png). Safe to re-run:
//
//   * reference tables that are missing are created;
//   * existing reference tables whose capacity/position differ are updated
//     (seats are only ever removed when they are free);
//   * active tables that are NOT in the reference layout (e.g. the earlier
//     A1-D3 sample tables) are deactivated together with their free seats, so
//     they disappear from the map and from allocation. Nothing is deleted, so
//     past visits keep their table references. A table with someone seated or
//     on hold is left alone and reported; re-run the seed once it is free.
//
//   npm run seed                      # floor plan only
//   npm run seed -- --with-test-data  # also sample students, cards and two terminals
//
// --with-test-data refuses to run when NODE_ENV=production.
const crypto = require('crypto')
const { parseArgs, run } = require('./_cli')
const { config } = require('../src/config/env')
const { LibraryTable, Seat, Student, GateTerminal } = require('../src/models')
const adminService = require('../src/services/adminService')
const authService = require('../src/services/authService')
const { REFERENCE_TABLES } = require('../../shared/libraryLayout.mjs')
const { SEAT_STATUS } = require('../src/shared')

const args = parseArgs()

function sameLocation(a, b) {
  return ['x', 'y', 'width', 'height'].every((k) => a?.[k] === b?.[k])
}

async function applyReferenceLayout() {
  const counts = { created: 0, updated: 0, unchanged: 0, retired: 0, blocked: [] }

  for (const t of REFERENCE_TABLES) {
    const existing = await LibraryTable.findOne({ tableCode: t.tableCode })
    if (!existing) {
      await adminService.createTable(t, null)
      counts.created += 1
      continue
    }
    const changes = {}
    if (existing.capacity !== t.capacity) changes.capacity = t.capacity
    if (!sameLocation(existing.location, t.location)) changes.location = t.location
    if (existing.name !== t.name) changes.name = t.name
    if (!existing.isActive) changes.isActive = true
    if (!Object.keys(changes).length) {
      counts.unchanged += 1
      continue
    }
    try {
      await adminService.updateTable(existing._id, changes, null)
      if (changes.isActive) await Seat.updateMany({ tableId: existing._id }, { $set: { isActive: true } })
      counts.updated += 1
    } catch (err) {
      counts.blocked.push(`${t.tableCode} (${err.message})`)
    }
  }

  const codes = REFERENCE_TABLES.map((t) => t.tableCode)
  const extras = await LibraryTable.find({ tableCode: { $nin: codes }, isActive: true })
  for (const table of extras) {
    try {
      // Refuses (SEATS_IN_USE) while any seat is occupied or reserved.
      await adminService.updateTable(table._id, { isActive: false }, null)
      await Seat.updateMany(
        { tableId: table._id, status: SEAT_STATUS.AVAILABLE },
        { $set: { isActive: false } }
      )
      counts.retired += 1
    } catch (err) {
      counts.blocked.push(`${table.tableCode} (${err.message})`)
    }
  }
  return counts
}

const TEST_STUDENTS = [
  {
    entryNumber: '2021CS10001',
    name: 'Aarav Sharma',
    email: 'cs1210001@iitd.ac.in',
    department: 'Computer Science',
    programme: 'B.Tech',
    cardUid: '04A1B2C301'
  },
  {
    entryNumber: '2022EE10002',
    name: 'Diya Patel',
    email: 'ee1220002@iitd.ac.in',
    department: 'Electrical Engineering',
    programme: 'B.Tech',
    cardUid: '04A1B2C302'
  },
  {
    entryNumber: '2023ME20003',
    name: 'Rohan Gupta',
    email: 'me2230003@iitd.ac.in',
    department: 'Mechanical Engineering',
    programme: 'M.Tech',
    cardUid: '04A1B2C303'
  }
]

run(async () => {
  const c = await applyReferenceLayout()
  console.log(
    `Floor plan: ${REFERENCE_TABLES.length} reference tables (${c.created} created, ${c.updated} updated, ` +
      `${c.unchanged} unchanged); ${c.retired} non-reference table(s) deactivated.`
  )
  if (c.blocked.length) {
    console.log(`Not changed because seats are in use (re-run later): ${c.blocked.join(', ')}`)
  }

  if (!args['with-test-data']) return
  if (config.isProduction) throw new Error('Refusing to create test data with NODE_ENV=production.')

  const password = process.env.SEED_STUDENT_PASSWORD || crypto.randomBytes(9).toString('base64url')
  for (const s of TEST_STUDENTS) {
    if (await Student.exists({ entryNumber: s.entryNumber })) continue
    await Student.create({ ...s, passwordHash: await authService.hashPassword(password) })
    await adminService.registerCard({ entryNumber: s.entryNumber, cardUid: s.cardUid }, null)
    console.log(`Student ${s.entryNumber} <${s.email}> card UID ${s.cardUid}`)
  }
  if (!process.env.SEED_STUDENT_PASSWORD) console.log(`Test student password: ${password}`)

  for (const t of [
    { terminalCode: 'ENTRY-1', gateType: 'entry', name: 'Main entrance' },
    { terminalCode: 'EXIT-1', gateType: 'exit', name: 'Main exit' }
  ]) {
    if (await GateTerminal.exists({ terminalCode: t.terminalCode })) {
      console.log(
        `Terminal ${t.terminalCode} exists (rotate with npm run create-terminal -- --code ${t.terminalCode} --rotate).`
      )
      continue
    }
    const { terminalKey } = await adminService.createTerminal(t, null)
    console.log(
      `Terminal ${t.terminalCode}: GATE_TERMINAL_CODE=${t.terminalCode} GATE_TERMINAL_KEY=${terminalKey}`
    )
  }
})
