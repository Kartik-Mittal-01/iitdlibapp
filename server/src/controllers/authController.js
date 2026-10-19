const authService = require('../services/authService')
const otpService = require('../services/otpService')
const audit = require('../services/auditService')
const { ok } = require('../utils/http')

async function register(req, res) {
  const result = await authService.registerStudent(req.valid.body)
  ok(res, result, 201)
}

async function requestOtp(req, res) {
  const result = await otpService.requestOtp(req.valid.body.email, {
    isAllowedStudentEmail: authService.isAllowedStudentEmail
  })
  ok(res, result)
}

async function verifyOtp(req, res) {
  ok(res, await otpService.verifyOtp(req.valid.body.email, req.valid.body.otp))
}

async function login(req, res) {
  ok(res, await authService.loginStudent(req.valid.body))
}

async function staffLogin(req, res) {
  ok(res, await authService.loginStaff(req.valid.body))
}

async function logout(req, res) {
  await authService.revoke(req.principal)
  if (req.principal.type === 'staff') {
    await audit.record({ actor: req.principal, action: 'staff.logout' })
  }
  ok(res, { loggedOut: true })
}

function me(req, res) {
  const key = req.principal.type === 'staff' ? 'staff' : 'student'
  ok(res, { [key]: req.principal.doc.toJSON() })
}

module.exports = { register, requestOtp, verifyOtp, login, staffLogin, logout, me }
