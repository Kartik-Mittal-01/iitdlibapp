const { rateLimit, ipKeyGenerator } = require('express-rate-limit')
const { config } = require('../config/env')
const { errorMessage } = require('../shared')

function limiter({ windowMs, limit, keyGenerator }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => !config.rateLimit.enabled,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: errorMessage('RATE_LIMITED') }
      })
    }
  })
}

const loginLimiter = limiter({
  windowMs: config.rateLimit.loginWindowMs,
  limit: config.rateLimit.loginMax
})

const registerLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  limit: config.rateLimit.registerMax
})

// Registration OTPs, per client IP (per-email cooldown and attempt limits are
// enforced separately in otpService).
const otpRequestLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: config.rateLimit.otpRequestMax
})

const otpVerifyLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: config.rateLimit.otpVerifyMax
})

const apiLimiter = limiter({ windowMs: 60 * 1000, limit: config.rateLimit.apiMax })

// Applied after terminal authentication: limits each terminal, not each IP.
const gateLimiter = limiter({
  windowMs: 60 * 1000,
  limit: config.rateLimit.gateMax,
  keyGenerator: (req) =>
    req.principal?.terminalCode ? `terminal:${req.principal.terminalCode}` : ipKeyGenerator(req.ip)
})

module.exports = {
  loginLimiter,
  registerLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  apiLimiter,
  gateLimiter
}
