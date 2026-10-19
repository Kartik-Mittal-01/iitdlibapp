const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { Student, Staff, GateTerminal, RevokedToken } = require('../models')
const { config } = require('../config/env')
const AppError = require('../utils/AppError')
const { sha256, safeEqualHex } = require('../utils/crypto')
const audit = require('./auditService')
const otpService = require('./otpService')

const ISSUER = 'iitd-library'
const TOKEN_TTL = {
  student: () => config.studentTokenTtl,
  staff: () => config.staffTokenTtl,
  terminal: () => config.terminalTokenTtl
}

// Compared against when an account does not exist, so response timing does not
// reveal which emails are registered.
let dummyHash = null
async function getDummyHash() {
  if (!dummyHash)
    dummyHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), config.bcryptRounds)
  return dummyHash
}

function hashPassword(password) {
  return bcrypt.hash(password, config.bcryptRounds)
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash || (await getDummyHash()))
}

function signToken(type, subject, claims = {}) {
  const jti = crypto.randomUUID()
  const token = jwt.sign({ ...claims, typ: type }, config.jwtSecret, {
    subject: String(subject),
    issuer: ISSUER,
    audience: type,
    expiresIn: TOKEN_TTL[type](),
    jwtid: jti,
    algorithm: 'HS256'
  })
  const { exp } = jwt.decode(token)
  return { token, expiresAt: new Date(exp * 1000) }
}

/** Verifies a bearer token and loads the active principal it refers to. */
async function resolveToken(token) {
  let payload
  try {
    payload = jwt.verify(token, config.jwtSecret, { issuer: ISSUER, algorithms: ['HS256'] })
  } catch {
    throw AppError.unauthorized('UNAUTHENTICATED', 'Invalid or expired token.')
  }
  const { typ, sub, jti, exp } = payload
  if (!['student', 'staff', 'terminal'].includes(typ) || payload.aud !== typ) {
    throw AppError.unauthorized('UNAUTHENTICATED', 'Invalid token.')
  }
  if (await RevokedToken.exists({ jti })) {
    throw AppError.unauthorized('UNAUTHENTICATED', 'This session has been signed out.')
  }
  const base = { type: typ, id: sub, jti, exp }

  if (typ === 'student') {
    const doc = await Student.findById(sub)
    if (!doc || !doc.isActive)
      throw AppError.unauthorized('UNAUTHENTICATED', 'Account is inactive.')
    return { ...base, doc }
  }
  if (typ === 'staff') {
    const doc = await Staff.findById(sub)
    if (!doc || !doc.isActive)
      throw AppError.unauthorized('UNAUTHENTICATED', 'Account is inactive.')
    return { ...base, doc, role: doc.role }
  }
  const doc = await GateTerminal.findById(sub)
  if (!doc || !doc.isActive || payload.cv !== doc.credentialVersion) {
    throw AppError.unauthorized('TERMINAL_UNAUTHORIZED')
  }
  return { ...base, doc, terminalCode: doc.terminalCode, gateType: doc.gateType }
}

async function revoke(principal) {
  await RevokedToken.updateOne(
    { jti: principal.jti },
    { $setOnInsert: { jti: principal.jti, expiresAt: new Date(principal.exp * 1000) } },
    { upsert: true }
  )
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

function isAllowedStudentEmail(email) {
  const at = email.lastIndexOf('@')
  if (at < 1) return false
  const domain = email.slice(at + 1)
  return config.studentEmailDomains.some(
    (d) => domain === d || (config.studentEmailAllowSubdomains && domain.endsWith(`.${d}`))
  )
}

/**
 * Creates a student account. Requires a registration token from a successful
 * email OTP verification of this exact email address (see otpService).
 */
async function registerStudent(input) {
  if (!isAllowedStudentEmail(input.email)) throw AppError.badRequest('EMAIL_NOT_ALLOWED')
  const verification = await otpService.findRegistrationToken(input.registrationToken)
  if (!verification || verification.email !== input.email) {
    throw AppError.forbidden('EMAIL_NOT_VERIFIED')
  }
  const passwordHash = await hashPassword(input.password)
  let student
  try {
    student = await Student.create({
      entryNumber: input.entryNumber,
      name: input.name,
      email: input.email,
      passwordHash,
      department: input.department,
      programme: input.programme
    })
  } catch (err) {
    // The unique email index also stops a token being used twice concurrently.
    if (err.code === 11000) throw AppError.conflict('DUPLICATE_STUDENT')
    throw err
  }
  await otpService.consumeRegistrationToken(verification)
  await audit.record({
    actor: { type: 'student', id: student._id },
    action: 'student.registered',
    studentId: student._id
  })
  return { student: student.toJSON(), ...signToken('student', student._id) }
}

async function loginStudent({ identifier, password }) {
  const id = identifier.trim()
  const query = id.includes('@') ? { email: id.toLowerCase() } : { entryNumber: id.toUpperCase() }
  const student = await Student.findOne(query).select('+passwordHash')
  const valid = await verifyPassword(password, student?.passwordHash)
  if (!student || !valid) {
    await audit.record({
      actor: null,
      action: 'student.login_failed',
      outcome: 'rejected',
      studentId: student?._id || null,
      reason: 'INVALID_CREDENTIALS'
    })
    throw AppError.unauthorized('INVALID_CREDENTIALS')
  }
  if (!student.isActive) throw AppError.forbidden('STUDENT_INACTIVE')
  return { student: student.toJSON(), ...signToken('student', student._id) }
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

async function loginStaff({ email, password }) {
  const staff = await Staff.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash')
  const valid = await verifyPassword(password, staff?.passwordHash)
  if (!staff || !valid || !staff.isActive) {
    await audit.record({
      actor: null,
      action: 'staff.login_failed',
      outcome: 'rejected',
      reason: 'INVALID_CREDENTIALS',
      details: { staffId: staff?._id || null }
    })
    throw AppError.unauthorized('INVALID_CREDENTIALS')
  }
  await audit.record({ actor: { type: 'staff', id: staff._id }, action: 'staff.login' })
  return { staff: staff.toJSON(), ...signToken('staff', staff._id, { role: staff.role }) }
}

async function createStaff({ name, email, password, role }) {
  const passwordHash = await hashPassword(password)
  return Staff.create({ name, email, passwordHash, role })
}

// ---------------------------------------------------------------------------
// Gate terminals
// ---------------------------------------------------------------------------

async function authenticateTerminalKey(terminalCode, key) {
  const terminal = await GateTerminal.findOne({
    terminalCode: String(terminalCode).trim().toUpperCase()
  }).select('+credentialHash')
  const valid = terminal && safeEqualHex(sha256(key), terminal.credentialHash)
  if (!terminal || !valid || !terminal.isActive) {
    await audit.record({
      actor: null,
      action: 'terminal.auth_failed',
      outcome: 'rejected',
      terminalCode: terminal?.terminalCode || null,
      reason: 'TERMINAL_UNAUTHORIZED'
    })
    throw AppError.unauthorized('TERMINAL_UNAUTHORIZED')
  }
  return terminal
}

function issueTerminalToken(terminal) {
  return signToken('terminal', terminal._id, { cv: terminal.credentialVersion })
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  resolveToken,
  revoke,
  isAllowedStudentEmail,
  registerStudent,
  loginStudent,
  loginStaff,
  createStaff,
  authenticateTerminalKey,
  issueTerminalToken
}
