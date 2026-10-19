const { Router } = require('express')
const ctrl = require('../controllers/authController')
const { authenticate } = require('../middleware/auth')
const { validate, z } = require('../middleware/validate')
const {
  loginLimiter,
  registerLimiter,
  otpRequestLimiter,
  otpVerifyLimiter
} = require('../middleware/rateLimit')

const router = Router()

// bcrypt only uses the first 72 bytes of a password; reject longer ones explicitly.
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes')

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email')

const registerSchema = z.object({
  // Issued by POST /register/verify-otp for this email; required (checked by the service).
  registrationToken: z.string().max(200).optional(),
  entryNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6,15}$/, 'Entry number must be 6–15 letters/digits'),
  name: z.string().trim().min(1).max(120),
  email,
  password,
  department: z.string().trim().min(1).max(120),
  programme: z.string().trim().min(1).max(120)
})

const loginSchema = z.object({
  // Email address or entry number.
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200)
})

// Email verification for registration: request a code, then exchange it for a
// short-lived registration token that POST /register requires.
router.post(
  '/register/request-otp',
  otpRequestLimiter,
  validate({ body: z.object({ email }) }),
  ctrl.requestOtp
)
router.post(
  '/register/verify-otp',
  otpVerifyLimiter,
  validate({
    body: z.object({
      email,
      otp: z
        .string()
        .trim()
        .regex(/^\d{6}$/, 'Enter the 6-digit code')
    })
  }),
  ctrl.verifyOtp
)
router.post('/register', registerLimiter, validate({ body: registerSchema }), ctrl.register)
router.post('/login', loginLimiter, validate({ body: loginSchema }), ctrl.login)
router.post('/logout', authenticate('student', 'staff'), ctrl.logout)
router.get('/me', authenticate('student'), ctrl.me)

module.exports = router
