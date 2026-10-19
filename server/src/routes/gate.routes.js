const { Router } = require('express')
const ctrl = require('../controllers/gateController')
const { authenticate, authenticateTerminal } = require('../middleware/auth')
const { validate, z, objectId } = require('../middleware/validate')
const { gateLimiter } = require('../middleware/rateLimit')
const { EXIT_MODES } = require('../shared')

const router = Router()

const scanSchema = z.object({
  // Hex UID as read from the card, e.g. "04A31B22" or "04:A3:1B:22".
  cardUid: z
    .string()
    .trim()
    .max(64)
    .regex(/^[0-9A-Fa-f:\s-]+$/, 'cardUid must be hex')
    .refine(
      (v) => /^[0-9A-F]{8,32}$/i.test(v.replace(/[\s:-]/g, '')),
      'cardUid must be 4–16 bytes'
    ),
  // Optional idempotency key so device retries of one physical scan are not double-processed.
  requestId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional()
})

const scanToken = z.string().min(20).max(100)

const entrySchema = z
  .object({ scanToken, tableId: objectId.optional(), seatId: objectId.optional() })
  .refine((b) => b.tableId || b.seatId, 'tableId or seatId is required')
// A hold resume needs no seat choice, so only the token is required there; the
// service decides which case applies from server-side state.
const entryOrResumeSchema = z.union([entrySchema, z.object({ scanToken })])

const exitSchema = z.object({ scanToken, mode: z.enum([EXIT_MODES.EXIT, EXIT_MODES.HOLD]) })

// Exchange a device key for a short-lived terminal token (kiosk apps).
router.post('/terminal/token', authenticateTerminal(), gateLimiter, ctrl.terminalToken)
router.get('/terminal/me', authenticateTerminal(), ctrl.terminalMe)

router.post('/scan', authenticateTerminal(), gateLimiter, validate({ body: scanSchema }), ctrl.scan)
router.post(
  '/entry',
  authenticateTerminal(),
  gateLimiter,
  validate({ body: entryOrResumeSchema }),
  ctrl.entry
)
router.post('/exit', authenticateTerminal(), gateLimiter, validate({ body: exitSchema }), ctrl.exit)

router.get(
  '/status/:entryNumber',
  authenticate('student', 'staff'),
  validate({
    params: z.object({
      entryNumber: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9]{6,15}$/)
    })
  }),
  ctrl.status
)

module.exports = router
