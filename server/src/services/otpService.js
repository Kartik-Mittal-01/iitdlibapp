// Email OTP verification for student registration.
//
//   1. requestOtp(email)        – checks the email policy and that the email is not
//                                 registered, then emails a 6-digit code (5 minutes).
//   2. verifyOtp(email, otp)    – max 5 attempts per code; on success issues a
//                                 single-use registration token (15 minutes) bound
//                                 to that email.
//   3. findRegistrationToken /  – used by authService.registerStudent: an account is
//      consumeRegistrationToken   only created with a valid token for the same email.
//
// OTPs and tokens are stored only as keyed hashes and are never logged or returned.

const crypto = require('crypto')
const { EmailVerification, Student } = require('../models')
const { config } = require('../config/env')
const AppError = require('../utils/AppError')
const clock = require('./clock')
const mail = require('./mailService')
const audit = require('./auditService')
const { randomToken, sha256 } = require('../utils/crypto')

const PURPOSE = 'student_registration'
const OTP_TTL_MS = 5 * 60 * 1000
const MAX_ATTEMPTS = 5
const RESEND_COOLDOWN_MS = 60 * 1000
const SEND_WINDOW_MS = 60 * 60 * 1000
const MAX_SENDS_PER_WINDOW = 5
const TOKEN_TTL_MS = 15 * 60 * 1000
const PURGE_AFTER_MS = 24 * 60 * 60 * 1000

function otpHash(verificationId, otp) {
  return crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`otp:${verificationId}:${otp}`)
    .digest('hex')
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function generateOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

function maskEmail(email) {
  const [user, domain] = email.split('@')
  const shown = user.length <= 2 ? user[0] : `${user.slice(0, 2)}`
  return `${shown}${'•'.repeat(Math.max(1, user.length - shown.length))}@${domain}`
}

function otpEmail(otp, expiresAt) {
  const minutes = Math.round(OTP_TTL_MS / 60000)
  // The code is kept out of the subject (mail-server logs, lock-screen previews).
  const subject = 'Your IIT Delhi Library verification code'
  const text = [
    'IIT Delhi Central Library',
    '',
    `Your verification code is: ${otp}`,
    '',
    `It expires in ${minutes} minutes (at ${expiresAt.toUTCString()}).`,
    'Do not share this code with anyone. Library staff will never ask for it.',
    '',
    'If you did not try to create a library account, you can ignore this email.'
  ].join('\n')
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0a0a0a">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:6px">
    <tr><td style="padding:24px 28px;border-bottom:1px solid #e5e5e5">
      <div style="font-size:15px;font-weight:600">IIT Delhi Central Library</div>
      <div style="font-size:13px;color:#6b6b6b">Student account verification</div>
    </td></tr>
    <tr><td style="padding:28px">
      <p style="margin:0 0 12px;font-size:14px">Use this code to verify your email address:</p>
      <p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:8px;font-family:Menlo,Consolas,monospace">${otp}</p>
      <p style="margin:0 0 8px;font-size:13px;color:#404040">The code expires in <strong>${minutes} minutes</strong>.</p>
      <p style="margin:0 0 8px;font-size:13px;color:#404040"><strong>Do not share this code</strong> with anyone. Library staff will never ask for it.</p>
      <p style="margin:16px 0 0;font-size:12px;color:#6b6b6b">If you did not try to create a library account, you can ignore this email.</p>
    </td></tr>
  </table>
</body></html>`
  return { subject, text, html }
}

/**
 * Sends a registration OTP to an allowed, unregistered IIT Delhi email.
 * @returns {{ email, emailMasked, expiresAt, resendAvailableAt }}
 */
async function requestOtp(email, { isAllowedStudentEmail }) {
  const now = clock.now()
  if (!isAllowedStudentEmail(email)) throw AppError.badRequest('EMAIL_NOT_ALLOWED')
  if (await Student.exists({ email })) throw AppError.conflict('DUPLICATE_STUDENT')

  const existing = await EmailVerification.findOne({ email, purpose: PURPOSE })
  if (existing) {
    const wait = existing.lastSentAt.getTime() + RESEND_COOLDOWN_MS - now.getTime()
    if (wait > 0) {
      throw new AppError(429, 'OTP_COOLDOWN', undefined, {
        retryAfterSeconds: Math.ceil(wait / 1000)
      })
    }
  }
  const windowFresh =
    existing && now.getTime() - existing.sendWindowStartedAt.getTime() < SEND_WINDOW_MS
  if (windowFresh && existing.sendsInWindow >= MAX_SENDS_PER_WINDOW) {
    const wait = existing.sendWindowStartedAt.getTime() + SEND_WINDOW_MS - now.getTime()
    throw new AppError(429, 'OTP_TOO_MANY_REQUESTS', undefined, {
      retryAfterSeconds: Math.ceil(wait / 1000)
    })
  }

  // Fails fast (503) before touching the database if SMTP is not configured.
  mail.assertConfigured()

  const otp = generateOtp()
  const otpExpiresAt = new Date(now.getTime() + OTP_TTL_MS)
  const fields = {
    status: 'pending',
    otpHash: null,
    otpExpiresAt,
    attempts: 0,
    lastSentAt: now,
    sendWindowStartedAt: windowFresh ? existing.sendWindowStartedAt : now,
    sendsInWindow: (windowFresh ? existing.sendsInWindow : 0) + 1,
    tokenHash: null,
    tokenExpiresAt: null,
    verifiedAt: null,
    consumedAt: null,
    purgeAt: new Date(now.getTime() + PURGE_AFTER_MS)
  }
  // Replace any previous request (its code and any unused token stop working).
  // Conditional on the lastSentAt we read, so two simultaneous requests cannot
  // both pass the cooldown and send two emails.
  let doc
  try {
    doc = existing
      ? await EmailVerification.findOneAndUpdate(
          { _id: existing._id, lastSentAt: existing.lastSentAt },
          { $set: fields },
          { returnDocument: 'after' }
        )
      : await EmailVerification.create({ email, purpose: PURPOSE, ...fields })
  } catch (err) {
    if (err.code !== 11000) throw err
    doc = null
  }
  if (!doc) {
    throw new AppError(429, 'OTP_COOLDOWN', undefined, {
      retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_MS / 1000)
    })
  }
  await EmailVerification.updateOne({ _id: doc._id }, { $set: { otpHash: otpHash(doc._id, otp) } })

  try {
    await mail.send({ to: email, ...otpEmail(otp, otpExpiresAt) })
  } catch (err) {
    // Nothing was delivered: make sure no usable code remains.
    await EmailVerification.updateOne(
      { _id: doc._id },
      // No code was delivered, so do not hold the student to the resend cooldown.
      { $set: { otpHash: null, otpExpiresAt: null, status: 'pending', lastSentAt: new Date(0) } }
    )
    await audit.record({
      actor: null,
      action: 'student.otp_send_failed',
      outcome: 'rejected',
      reason: err.code,
      details: { emailDomain: email.split('@')[1] }
    })
    throw err
  }

  await audit.record({
    actor: null,
    action: 'student.otp_sent',
    outcome: 'info',
    details: { emailDomain: email.split('@')[1] }
  })
  return {
    email,
    emailMasked: maskEmail(email),
    expiresAt: otpExpiresAt,
    resendAvailableAt: new Date(now.getTime() + RESEND_COOLDOWN_MS),
    serverTime: now
  }
}

/**
 * Checks a code. Each check (right or wrong) uses one of MAX_ATTEMPTS, reserved
 * atomically before comparing, so concurrent guesses cannot exceed the limit.
 * @returns {{ registrationToken, email, expiresAt }}
 */
async function verifyOtp(email, otp) {
  const now = clock.now()
  const reserved = await EmailVerification.findOneAndUpdate(
    {
      email,
      purpose: PURPOSE,
      status: 'pending',
      otpHash: { $type: 'string' },
      otpExpiresAt: { $gt: now },
      attempts: { $lt: MAX_ATTEMPTS }
    },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' }
  )

  if (!reserved) {
    const doc = await EmailVerification.findOne({ email, purpose: PURPOSE })
    if (!doc || doc.status !== 'pending' || !doc.otpHash) {
      throw AppError.badRequest('OTP_NOT_FOUND')
    }
    if (doc.attempts >= MAX_ATTEMPTS) throw new AppError(429, 'OTP_ATTEMPTS_EXCEEDED')
    throw AppError.gone('OTP_EXPIRED')
  }

  if (!safeEqual(otpHash(reserved._id, otp), reserved.otpHash)) {
    const remaining = MAX_ATTEMPTS - reserved.attempts
    await audit.record({
      actor: null,
      action: 'student.otp_rejected',
      outcome: 'rejected',
      reason: remaining > 0 ? 'OTP_INVALID' : 'OTP_ATTEMPTS_EXCEEDED',
      details: { emailDomain: email.split('@')[1], attempts: reserved.attempts }
    })
    if (remaining <= 0) throw new AppError(429, 'OTP_ATTEMPTS_EXCEEDED')
    throw AppError.badRequest('OTP_INVALID', undefined, { attemptsRemaining: remaining })
  }

  const token = randomToken(32)
  const tokenExpiresAt = new Date(now.getTime() + TOKEN_TTL_MS)
  const verified = await EmailVerification.findOneAndUpdate(
    { _id: reserved._id, status: 'pending', otpHash: reserved.otpHash },
    {
      $set: {
        status: 'verified',
        otpHash: null, // the code can never be used again
        otpExpiresAt: null,
        verifiedAt: now,
        tokenHash: sha256(token),
        tokenExpiresAt
      }
    },
    { returnDocument: 'after' }
  )
  // A concurrent resend replaced this code between the check and the update.
  if (!verified) throw AppError.badRequest('OTP_NOT_FOUND')

  await audit.record({
    actor: null,
    action: 'student.otp_verified',
    outcome: 'info',
    details: { emailDomain: email.split('@')[1] }
  })
  return { registrationToken: token, email, expiresAt: tokenExpiresAt }
}

/** The verification record a registration token belongs to, if still valid. */
async function findRegistrationToken(token) {
  if (typeof token !== 'string' || token.length < 20) return null
  return EmailVerification.findOne({
    tokenHash: sha256(token),
    purpose: PURPOSE,
    status: 'verified',
    tokenExpiresAt: { $gt: clock.now() }
  })
}

async function consumeRegistrationToken(verification) {
  await EmailVerification.updateOne(
    { _id: verification._id, status: 'verified' },
    { $set: { status: 'consumed', tokenHash: null, consumedAt: clock.now() } }
  )
}

module.exports = {
  requestOtp,
  verifyOtp,
  findRegistrationToken,
  consumeRegistrationToken,
  maskEmail,
  OTP_TTL_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  TOKEN_TTL_MS
}
