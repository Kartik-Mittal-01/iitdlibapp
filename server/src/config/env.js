const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true })

function list(value, fallback = []) {
  if (!value) return fallback
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

const nodeEnv = process.env.NODE_ENV || 'development'

const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: int(process.env.PORT, 5001),
  mongoUri: process.env.MONGODB_URI || '',
  trustProxy: process.env.TRUST_PROXY || false,

  jwtSecret: process.env.JWT_SECRET || '',
  studentTokenTtl: process.env.STUDENT_TOKEN_TTL || '12h',
  staffTokenTtl: process.env.STAFF_TOKEN_TTL || '8h',
  terminalTokenTtl: process.env.TERMINAL_TOKEN_TTL || '12h',

  // HMAC pepper used to hash RFID card UIDs before storing/looking them up.
  cardUidPepper: process.env.CARD_UID_PEPPER || '',

  corsOrigins: list(process.env.CORS_ORIGINS, [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175'
  ]),
  // Packaged Electron apps load from file:// and send "Origin: null".
  corsAllowNullOrigin: bool(process.env.CORS_ALLOW_NULL_ORIGIN, true),

  studentEmailDomains: list(process.env.STUDENT_EMAIL_DOMAINS, ['iitd.ac.in']).map((d) =>
    d.toLowerCase()
  ),
  studentEmailAllowSubdomains: bool(process.env.STUDENT_EMAIL_ALLOW_SUBDOMAINS, true),

  // Outgoing email (registration OTPs). Delivery fails clearly when unset.
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    // true for implicit TLS (port 465); otherwise STARTTLS is used when offered.
    secure:
      process.env.SMTP_SECURE === undefined || process.env.SMTP_SECURE === ''
        ? int(process.env.SMTP_PORT, 587) === 465
        : bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || ''
  },

  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 12),
  scanTokenTtlSeconds: int(process.env.SCAN_TOKEN_TTL_SECONDS, 120),
  holdSweepIntervalMs: int(process.env.HOLD_SWEEP_INTERVAL_MS, 15000),

  rateLimit: {
    enabled: bool(process.env.RATE_LIMIT_ENABLED, true),
    loginMax: int(process.env.RATE_LIMIT_LOGIN_MAX, 10),
    loginWindowMs: int(process.env.RATE_LIMIT_LOGIN_WINDOW_MS, 15 * 60 * 1000),
    registerMax: int(process.env.RATE_LIMIT_REGISTER_MAX, 20),
    otpRequestMax: int(process.env.RATE_LIMIT_OTP_REQUEST_MAX, 10),
    otpVerifyMax: int(process.env.RATE_LIMIT_OTP_VERIFY_MAX, 30),
    gateMax: int(process.env.RATE_LIMIT_GATE_MAX, 120),
    apiMax: int(process.env.RATE_LIMIT_API_MAX, 600)
  }
}

function assertConfig() {
  const problems = []
  if (!config.mongoUri) problems.push('MONGODB_URI is required')
  if (config.jwtSecret.length < 32) problems.push('JWT_SECRET must be at least 32 characters')
  if (config.cardUidPepper.length < 32)
    problems.push('CARD_UID_PEPPER must be at least 32 characters')
  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
  }
}

module.exports = { config, assertConfig }
