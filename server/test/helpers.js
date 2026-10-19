// Test harness: real mongod (mongodb-memory-server), the real Express app, a
// controllable clock and a recording Socket.IO double.
//
// TEST_MONGO_TOPOLOGY=standalone runs the same tests without transactions, to
// exercise the conditional-update + compensation path.
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-jwt-secret-0123456789-abcdefghijklmnopqrstuvwxyz'
process.env.CARD_UID_PEPPER = 'test-card-pepper-0123456789-abcdefghijklmnopqrstuvwxyz'
process.env.BCRYPT_ROUNDS = '4'
process.env.RATE_LIMIT_ENABLED = 'false'
process.env.STUDENT_EMAIL_DOMAINS = 'iitd.ac.in'
process.env.STUDENT_EMAIL_ALLOW_SUBDOMAINS = 'true'
// Tests must never send real email, whatever server/.env contains. Defining these
// (even empty) stops dotenv from loading the real SMTP settings.
for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) {
  process.env[key] = ''
}

const request = require('supertest')
const { MongoMemoryReplSet, MongoMemoryServer } = require('mongodb-memory-server')
const { connectDatabase, disconnectDatabase, supportsTransactions } = require('../src/db/connect')
const models = require('../src/models')
const { createApp } = require('../src/app')
const clock = require('../src/services/clock')
const publisher = require('../src/realtime/publisher')
const authService = require('../src/services/authService')
const adminService = require('../src/services/adminService')
const mailService = require('../src/services/mailService')

const STANDALONE = process.env.TEST_MONGO_TOPOLOGY === 'standalone'

let mongo = null
let app = null

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------
let current = new Date('2026-03-02T09:00:00.000Z')
function setNow(date) {
  current = new Date(date)
}
function advance(ms) {
  current = new Date(current.getTime() + ms)
}
function now() {
  return new Date(current)
}

// ---------------------------------------------------------------------------
// Socket.IO double: records every emit with its room.
// ---------------------------------------------------------------------------
const emitted = []
const fakeIo = {
  to(room) {
    return { emit: (event, payload) => emitted.push({ room, event, payload }) }
  }
}
function events(event, room) {
  return emitted.filter((e) => e.event === event && (!room || e.room === room))
}
function clearEvents() {
  emitted.length = 0
}

// ---------------------------------------------------------------------------
// Mail double: records messages instead of sending them over SMTP.
// ---------------------------------------------------------------------------
const sentMail = []
let failMail = false
const fakeTransport = {
  async sendMail(msg) {
    if (failMail) throw Object.assign(new Error('Simulated SMTP failure'), { code: 'ECONNECTION' })
    sentMail.push(msg)
    return { accepted: [msg.to], rejected: [] }
  }
}
function setMailFailure(on) {
  failMail = on
}
/** The OTP in the latest email to `email`, read from the message like a student would. */
function lastOtpFor(email) {
  const msg = [...sentMail].reverse().find((m) => m.to === email)
  return msg ? msg.text.match(/\b(\d{6})\b/)[1] : null
}

/** Full registration through the email OTP flow. Returns the /register response. */
async function registerVerified(body) {
  const email = body.email.trim().toLowerCase()
  const req = await request(app).post('/api/auth/register/request-otp').send({ email: body.email })
  if (req.status !== 200) return req
  const ver = await request(app)
    .post('/api/auth/register/verify-otp')
    .send({ email: body.email, otp: lastOtpFor(email) })
  if (ver.status !== 200) return ver
  return request(app)
    .post('/api/auth/register')
    .send({ ...body, registrationToken: ver.body.data.registrationToken })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
async function setup() {
  mongo = STANDALONE
    ? await MongoMemoryServer.create()
    : await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  await connectDatabase(mongo.getUri('iitd_library_test'))
  if (STANDALONE !== !supportsTransactions()) {
    throw new Error('Unexpected transaction support for the selected topology')
  }
  clock.set(now)
  publisher.setIo(fakeIo)
  mailService.setTransport(fakeTransport)
  app = createApp()
  return app
}

async function teardown() {
  publisher.setIo(null)
  mailService.setTransport(null)
  clock.reset()
  await disconnectDatabase()
  if (mongo) await mongo.stop()
}

async function resetDb() {
  await Promise.all(Object.values(models).map((m) => m.deleteMany({})))
  setNow('2026-03-02T09:00:00.000Z')
  clearEvents()
  sentMail.length = 0
  failMail = false
}

function api() {
  return request(app)
}

function mongoUri() {
  return mongo.getUri('iitd_library_test')
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let seq = 0
async function createStudent(overrides = {}) {
  seq += 1
  const n = String(seq).padStart(5, '0')
  const password = overrides.password || 'correct horse battery'
  const student = await models.Student.create({
    entryNumber: `2024CS${n}`,
    name: `Student ${n}`,
    email: `cs${n}@iitd.ac.in`,
    department: 'Computer Science',
    programme: 'B.Tech',
    passwordHash: await authService.hashPassword(password),
    ...overrides
  })
  const token = authService.signToken('student', student._id).token
  return { student, token, password }
}

async function createStudentWithCard(overrides = {}) {
  const s = await createStudent(overrides)
  const cardUid = `04${String(s.student._id).slice(-10).toUpperCase()}`
  const card = await adminService.registerCard(
    { entryNumber: s.student.entryNumber, cardUid },
    null
  )
  return { ...s, cardUid, card }
}

async function createStaff(role = 'admin') {
  seq += 1
  const password = 'staff-password-123'
  const staff = await authService.createStaff({
    name: `Staff ${seq}`,
    email: `staff${seq}@iitd.ac.in`,
    password,
    role
  })
  return { staff, password, token: authService.signToken('staff', staff._id, { role }).token }
}

async function createTerminal(gateType, code) {
  seq += 1
  const { terminal, terminalKey } = await adminService.createTerminal(
    {
      terminalCode: code || `${gateType.toUpperCase()}-${seq}`,
      gateType,
      name: `${gateType} ${seq}`
    },
    null
  )
  const doc = await models.GateTerminal.findById(terminal._id)
  return {
    terminal: doc,
    key: terminalKey,
    headers: { 'X-Terminal-Code': doc.terminalCode, 'X-Terminal-Key': terminalKey }
  }
}

async function createTable(tableCode, capacity) {
  const table = await adminService.createTable(
    {
      tableCode,
      name: `Table ${tableCode}`,
      capacity,
      location: { x: 10, y: 40, width: 120, height: 50 }
    },
    null
  )
  const seats = await models.Seat.find({ tableId: table._id }).sort({ seatNumber: 1 })
  return { table, seats }
}

// ---------------------------------------------------------------------------
// Gate helpers (HTTP, exactly as the ESP32 and kiosk call them)
// ---------------------------------------------------------------------------
function scan(term, cardUid, extra = {}) {
  return api()
    .post('/api/gate/scan')
    .set(term.headers)
    .send({ cardUid, ...extra })
}

function entry(term, body) {
  return api().post('/api/gate/entry').set(term.headers).send(body)
}

function exit(term, body) {
  return api().post('/api/gate/exit').set(term.headers).send(body)
}

/** Scan at an entry terminal and choose a table/seat. */
async function enter(term, cardUid, choice) {
  const s = await scan(term, cardUid)
  if (s.status !== 200) return s
  return entry(term, { scanToken: s.body.data.scanToken, ...choice })
}

/** Scan at an exit terminal and choose exit/hold. */
async function leave(term, cardUid, mode) {
  const s = await scan(term, cardUid)
  if (s.status !== 200) return s
  return exit(term, { scanToken: s.body.data.scanToken, mode })
}

/** Awaits a response and asserts its status (shows the body on failure). */
async function must(promise, status) {
  const res = await promise
  if (res.status !== status) {
    throw new Error(`Expected HTTP ${status}, got ${res.status}: ${JSON.stringify(res.body)}`)
  }
  return res
}

module.exports = {
  STANDALONE,
  must,
  sentMail,
  setMailFailure,
  lastOtpFor,
  registerVerified,
  setup,
  teardown,
  resetDb,
  api,
  mongoUri,
  models,
  setNow,
  advance,
  now,
  events,
  clearEvents,
  emitted,
  createStudent,
  createStudentWithCard,
  createStaff,
  createTerminal,
  createTable,
  scan,
  entry,
  exit,
  enter,
  leave
}
