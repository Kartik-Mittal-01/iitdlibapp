const nodemailer = require('nodemailer')
const { config } = require('../config/env')
const AppError = require('../utils/AppError')

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email'
const BREVO_TIMEOUT_MS = 20000

let transport = null
let injected = false

/** 'brevo' (HTTPS API) when BREVO_API_KEY is set, otherwise 'smtp'. */
function provider() {
  return config.brevo.apiKey ? 'brevo' : 'smtp'
}

function isConfigured() {
  return Boolean((config.brevo.apiKey || config.smtp.host) && config.smtp.from)
}

// "Name <email@x>" or a bare "email@x" -> Brevo's { name?, email }.
function parseAddress(value) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(String(value || ''))
  if (!m) return { email: String(value || '').trim() }
  const name = m[1].trim()
  return name ? { name, email: m[2].trim() } : { email: m[2].trim() }
}

/**
 * Brevo transactional email API, exposed with the same sendMail() shape as a
 * nodemailer transport so send() and its error handling stay unchanged.
 * Errors carry only a code and a short reason; the API key is never included.
 */
function createBrevoTransport(apiKey, { fetchImpl = fetch, timeoutMs = BREVO_TIMEOUT_MS } = {}) {
  return {
    async sendMail({ from, to, subject, text, html }) {
      let res
      try {
        res = await fetchImpl(BREVO_API_URL, {
          method: 'POST',
          headers: {
            'api-key': apiKey,
            accept: 'application/json',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            sender: parseAddress(from),
            to: [{ email: to }],
            subject,
            textContent: text,
            htmlContent: html
          }),
          signal: AbortSignal.timeout(timeoutMs)
        })
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
        throw Object.assign(
          new Error(timedOut ? 'Brevo API request timed out' : 'Could not reach the Brevo API'),
          { code: timedOut ? 'ETIMEDOUT' : 'ECONNECTION' }
        )
      }
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        const reason = typeof body?.message === 'string' ? `: ${body.message.slice(0, 200)}` : ''
        throw Object.assign(new Error(`Brevo API rejected the message (HTTP ${res.status}${reason})`), {
          code: typeof body?.code === 'string' ? body.code : `HTTP_${res.status}`
        })
      }
      return { messageId: body?.messageId, rejected: [] }
    }
  }
}

/** Throws EMAIL_NOT_CONFIGURED unless messages can actually be sent. */
function assertConfigured() {
  if (transport) return
  if (!isConfigured()) {
    throw new AppError(
      503,
      'EMAIL_NOT_CONFIGURED',
      'Email delivery is not configured on the server. An administrator must set SMTP_FROM and either BREVO_API_KEY or SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS.'
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
  if (provider() === 'brevo') {
    transport = createBrevoTransport(config.brevo.apiKey)
    return transport
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

module.exports = { send, isConfigured, assertConfigured, setTransport, provider, createBrevoTransport }
