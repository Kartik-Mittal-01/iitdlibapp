const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const nodemailer = require('nodemailer')
const h = require('./helpers')
const mailService = require('../src/services/mailService')
const { EmailVerification, Student } = h.models

const EMAIL = 'cs1240001@iitd.ac.in'
const DETAILS = {
  entryNumber: '2024CS40001',
  name: 'Otp Student',
  email: EMAIL,
  password: 'a-strong-password',
  department: 'Computer Science',
  programme: 'B.Tech'
}
const MIN = 60 * 1000

function requestOtp(email = EMAIL) {
  return h.api().post('/api/auth/register/request-otp').send({ email })
}
function verifyOtp(otp, email = EMAIL) {
  return h.api().post('/api/auth/register/verify-otp').send({ email, otp })
}
function register(body) {
  return h.api().post('/api/auth/register').send(body)
}
function wrongCode(otp) {
  return otp === '000000' ? '000001' : '000000'
}

describe('email OTP verification for student registration', () => {
  before(h.setup)
  after(h.teardown)
  beforeEach(h.resetDb)

  test('sends a 6-digit code by email; never returns or stores it in plaintext', async () => {
    const res = await requestOtp(' CS1240001@IITD.AC.IN ')
    assert.equal(res.status, 200)
    assert.equal(res.body.data.email, EMAIL) // normalised
    assert.equal(res.body.data.emailMasked, 'cs•••••••@iitd.ac.in')
    assert.equal(new Date(res.body.data.expiresAt) - h.now(), 5 * MIN)
    assert.equal(new Date(res.body.data.resendAvailableAt) - h.now(), 60 * 1000)

    assert.equal(h.sentMail.length, 1)
    const msg = h.sentMail[0]
    assert.equal(msg.to, EMAIL)
    const otp = h.lastOtpFor(EMAIL)
    assert.match(otp, /^\d{6}$/)
    assert.match(msg.subject, /IIT Delhi Library/)
    assert.match(msg.text, /expires in 5 minutes/)
    assert.match(msg.text, /Do not share this code/)
    assert.match(msg.html, new RegExp(otp))

    assert.ok(!JSON.stringify(res.body).includes(otp))
    const stored = await EmailVerification.findOne({ email: EMAIL }).lean()
    assert.ok(stored.otpHash && stored.otpHash !== otp)
    assert.ok(!JSON.stringify(stored).includes(otp))
    // Sending a code creates no account.
    assert.equal(await Student.countDocuments(), 0)
  })

  test('correct code issues a registration token; the account is created only on register', async () => {
    await h.must(requestOtp(), 200)
    const ver = await h.must(verifyOtp(h.lastOtpFor(EMAIL)), 200)
    const { registrationToken } = ver.body.data
    assert.ok(registrationToken)
    assert.equal(await Student.countDocuments(), 0)

    const reg = await h.must(register({ ...DETAILS, registrationToken }), 201)
    assert.equal(reg.body.data.student.email, EMAIL)
    assert.equal(await Student.countDocuments({ email: EMAIL }), 1)
    // The new account signs in normally.
    await h.must(
      h.api().post('/api/auth/login').send({ identifier: EMAIL, password: DETAILS.password }),
      200
    )
  })

  test('incorrect code is rejected and counts down attempts; no account is created', async () => {
    await h.must(requestOtp(), 200)
    const otp = h.lastOtpFor(EMAIL)
    const bad = await verifyOtp(wrongCode(otp))
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'OTP_INVALID')
    assert.equal(bad.body.error.details.attemptsRemaining, 4)
    assert.equal(await Student.countDocuments(), 0)
    // The correct code still works after one mistake.
    await h.must(verifyOtp(otp), 200)
  })

  test('at most 5 attempts per code, even with the correct code afterwards', async () => {
    await h.must(requestOtp(), 200)
    const otp = h.lastOtpFor(EMAIL)
    for (let i = 0; i < 4; i += 1) assert.equal((await verifyOtp(wrongCode(otp))).status, 400)
    const fifth = await verifyOtp(wrongCode(otp))
    assert.equal(fifth.status, 429)
    assert.equal(fifth.body.error.code, 'OTP_ATTEMPTS_EXCEEDED')
    const locked = await verifyOtp(otp)
    assert.equal(locked.status, 429)
    assert.equal(locked.body.error.code, 'OTP_ATTEMPTS_EXCEEDED')
  })

  test('concurrent guesses cannot exceed the attempt limit', async () => {
    await h.must(requestOtp(), 200)
    const otp = h.lastOtpFor(EMAIL)
    const results = await Promise.all(Array.from({ length: 12 }, () => verifyOtp(wrongCode(otp))))
    assert.equal(results.filter((r) => r.body.error?.code === 'OTP_INVALID').length, 4)
    const doc = await EmailVerification.findOne({ email: EMAIL }).lean()
    assert.equal(doc.attempts, 5)
  })

  test('expired code is rejected', async () => {
    await h.must(requestOtp(), 200)
    const otp = h.lastOtpFor(EMAIL)
    h.advance(5 * MIN + 1000)
    const res = await verifyOtp(otp)
    assert.equal(res.status, 410)
    assert.equal(res.body.error.code, 'OTP_EXPIRED')
  })

  test('a code cannot be reused after successful verification', async () => {
    await h.must(requestOtp(), 200)
    const otp = h.lastOtpFor(EMAIL)
    await h.must(verifyOtp(otp), 200)
    const again = await verifyOtp(otp)
    assert.equal(again.status, 400)
    assert.equal(again.body.error.code, 'OTP_NOT_FOUND')
  })

  test('resend cooldown is 60 seconds and a resend invalidates the previous code', async () => {
    await h.must(requestOtp(), 200)
    const first = h.lastOtpFor(EMAIL)
    h.advance(59 * 1000)
    const early = await requestOtp()
    assert.equal(early.status, 429)
    assert.equal(early.body.error.code, 'OTP_COOLDOWN')
    assert.equal(early.body.error.details.retryAfterSeconds, 1)
    assert.equal(h.sentMail.length, 1)

    h.advance(1000)
    await h.must(requestOtp(), 200)
    assert.equal(h.sentMail.length, 2)
    const second = h.lastOtpFor(EMAIL)
    if (first !== second) {
      const old = await verifyOtp(first)
      assert.equal(old.body.error.code, 'OTP_INVALID')
    }
    await h.must(verifyOtp(second), 200)
  })

  test('at most 5 codes per email per hour', async () => {
    for (let i = 0; i < 5; i += 1) {
      await h.must(requestOtp(), 200)
      h.advance(61 * 1000)
    }
    const sixth = await requestOtp()
    assert.equal(sixth.status, 429)
    assert.equal(sixth.body.error.code, 'OTP_TOO_MANY_REQUESTS')
    h.advance(60 * MIN)
    await h.must(requestOtp(), 200)
  })

  test('simultaneous requests send only one email', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => requestOtp()))
    assert.equal(results.filter((r) => r.status === 200).length, 1)
    assert.ok(
      results.filter((r) => r.status !== 200).every((r) => r.body.error.code === 'OTP_COOLDOWN')
    )
    assert.equal(h.sentMail.length, 1)
  })

  test('registration without verification is rejected', async () => {
    const none = await register(DETAILS)
    assert.equal(none.status, 403)
    assert.equal(none.body.error.code, 'EMAIL_NOT_VERIFIED')
    const forged = await register({ ...DETAILS, registrationToken: 'x'.repeat(43) })
    assert.equal(forged.status, 403)
    // A frontend "verified" flag means nothing to the server.
    const flagged = await register({ ...DETAILS, verified: true })
    assert.equal(flagged.status, 403)
    assert.equal(await Student.countDocuments(), 0)
  })

  test('a token verified for one email cannot register a different email', async () => {
    await h.must(requestOtp(), 200)
    const { registrationToken } = (await h.must(verifyOtp(h.lastOtpFor(EMAIL)), 200)).body.data
    const other = await register({
      ...DETAILS,
      email: 'someone.else@iitd.ac.in',
      registrationToken
    })
    assert.equal(other.status, 403)
    assert.equal(other.body.error.code, 'EMAIL_NOT_VERIFIED')
    assert.equal(await Student.countDocuments(), 0)
  })

  test('a registration token is single-use and expires', async () => {
    await h.must(requestOtp(), 200)
    const { registrationToken } = (await h.must(verifyOtp(h.lastOtpFor(EMAIL)), 200)).body.data
    await h.must(register({ ...DETAILS, registrationToken }), 201)
    const reuse = await register({ ...DETAILS, entryNumber: '2024CS40002', registrationToken })
    assert.equal(reuse.status, 403)
    assert.equal(await Student.countDocuments(), 1)

    const email2 = 'cs1240003@iitd.ac.in'
    await h.must(requestOtp(email2), 200)
    const t2 = (await h.must(verifyOtp(h.lastOtpFor(email2), email2), 200)).body.data
    h.advance(15 * MIN + 1000)
    const late = await register({
      ...DETAILS,
      email: email2,
      entryNumber: '2024CS40003',
      registrationToken: t2.registrationToken
    })
    assert.equal(late.status, 403)
  })

  test('concurrent registrations with one token create one account', async () => {
    await h.must(requestOtp(), 200)
    const { registrationToken } = (await h.must(verifyOtp(h.lastOtpFor(EMAIL)), 200)).body.data
    const results = await Promise.all(
      ['2024CS40011', '2024CS40012', '2024CS40013'].map((entryNumber) =>
        register({ ...DETAILS, entryNumber, registrationToken })
      )
    )
    assert.equal(results.filter((r) => r.status === 201).length, 1)
    assert.equal(await Student.countDocuments({ email: EMAIL }), 1)
  })

  test('already-registered and non-IITD emails cannot request a code', async () => {
    await h.createStudent({ email: EMAIL })
    const dup = await requestOtp()
    assert.equal(dup.status, 409)
    assert.equal(dup.body.error.code, 'DUPLICATE_STUDENT')
    const gmail = await requestOtp('someone@gmail.com')
    assert.equal(gmail.status, 400)
    assert.equal(gmail.body.error.code, 'EMAIL_NOT_ALLOWED')
    assert.equal(h.sentMail.length, 0)
  })

  test('email delivery failure is reported, leaves no usable code and no cooldown', async () => {
    h.setMailFailure(true)
    const res = await requestOtp()
    assert.equal(res.status, 502)
    assert.equal(res.body.error.code, 'EMAIL_DELIVERY_FAILED')
    assert.ok(!JSON.stringify(res.body).includes('Simulated'))
    const doc = await EmailVerification.findOne({ email: EMAIL }).lean()
    assert.equal(doc.otpHash, null)
    const verify = await verifyOtp('123456')
    assert.equal(verify.body.error.code, 'OTP_NOT_FOUND')
    // Nothing was sent, so the student can retry straight away.
    h.setMailFailure(false)
    await h.must(requestOtp(), 200)
  })

  test('missing SMTP configuration is reported clearly', async () => {
    // helpers.js blanks SMTP_* so this can never reach a real mail server.
    assert.equal(require('../src/config/env').config.smtp.host, '')
    mailService.setTransport(null)
    try {
      const res = await requestOtp()
      assert.equal(res.status, 503)
      assert.equal(res.body.error.code, 'EMAIL_NOT_CONFIGURED')
      assert.equal(await EmailVerification.countDocuments(), 0)
    } finally {
      mailService.setTransport({ sendMail: async (m) => (h.sentMail.push(m), { rejected: [] }) })
    }
  })

  test('the message builds as a valid MIME email with text and HTML parts', async () => {
    const json = nodemailer.createTransport({ jsonTransport: true })
    const captured = []
    mailService.setTransport({
      sendMail: async (m) => {
        captured.push(JSON.parse((await json.sendMail(m)).message))
        return { rejected: [] }
      }
    })
    await h.must(requestOtp(), 200)
    assert.equal(captured.length, 1)
    assert.ok(captured[0].text.includes('verification code'))
    assert.ok(captured[0].html.includes('<table'))
  })
})
