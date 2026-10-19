const nodemailer = require('nodemailer')
const { config } = require('../config/env')
const AppError = require('../utils/AppError')

let transport = null
let injected = false

function isConfigured() {
  return Boolean(config.smtp.host && config.smtp.from)
}

/** Throws EMAIL_NOT_CONFIGURED unless messages can actually be sent. */
function assertConfigured() {
  if (transport) return
  if (!isConfigured()) {
    throw new AppError(
      503,
      'EMAIL_NOT_CONFIGURED',
      'Email delivery is not configured on the server. An administrator must set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM in server/.env.'
    )
  }
}

function getTransport() {
  assertConfigured()
  if (transport) return transport
  // Backstop: an automated test run never opens a real SMTP connection.
  if (config.isTest) {
    throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'Real email delivery is disabled in tests.')
  }
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  })
  return transport
}

/** Tests replace the SMTP transport with an in-memory one. */
function setTransport(t) {
  transport = t
  injected = Boolean(t)
}

/**
 * Sends a message. Throws EMAIL_NOT_CONFIGURED when SMTP is not set up and
 * EMAIL_DELIVERY_FAILED when the server rejects it. Never reports success
 * unless the SMTP server accepted the message.
 */
async function send({ to, subject, text, html }) {
  const t = getTransport()
  try {
    const info = await t.sendMail({
      from: config.smtp.from || 'test@localhost',
      to,
      subject,
      text,
      html
    })
    if (!injected && Array.isArray(info.rejected) && info.rejected.length) {
      throw new Error('Recipient rejected by the mail server')
    }
    return info
  } catch (err) {
    // Log the transport error (no message content) for operators.
    console.error(`[mail] delivery failed: ${err.code || ''} ${err.message}`)
    throw new AppError(
      502,
      'EMAIL_DELIVERY_FAILED',
      'The verification email could not be sent. Please try again later or contact the library.'
    )
  }
}

module.exports = { send, isConfigured, assertConfigured, setTransport }
