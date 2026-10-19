const { Router } = require('express')
const ctrl = require('../controllers/adminController')
const authCtrl = require('../controllers/authController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate, z, objectId, isoDate, boolString, pagination } = require('../middleware/validate')
const { loginLimiter } = require('../middleware/rateLimit')
const { GATE_TYPES, SESSION_STATUS } = require('../shared')

const router = Router()

router.post(
  '/login',
  loginLimiter,
  validate({
    body: z.object({
      email: z.string().trim().min(3).max(254),
      password: z.string().min(1).max(200)
    })
  }),
  authCtrl.staffLogin
)

// Everything below requires a signed-in staff member.
router.use(authenticate('staff'))
const anyStaff = requireRole('admin', 'staff')
const adminOnly = requireRole('admin')

router.post('/logout', authCtrl.logout)
router.get('/me', (req, res) =>
  res.json({ success: true, data: { staff: req.principal.doc.toJSON() } })
)

router.get(
  '/logs',
  anyStaff,
  validate({
    query: z.object({
      ...pagination,
      action: z.string().trim().max(60).optional(),
      outcome: z.enum(['success', 'rejected', 'info']).optional(),
      actorType: z.enum(['student', 'staff', 'terminal', 'system']).optional(),
      terminalCode: z.string().trim().max(40).optional(),
      studentId: objectId.optional(),
      entryNumber: z.string().trim().max(15).optional(),
      from: isoDate.optional(),
      to: isoDate.optional()
    })
  }),
  ctrl.logs
)

router.get(
  '/students',
  anyStaff,
  validate({
    query: z.object({
      ...pagination,
      q: z.string().trim().max(100).optional(),
      isActive: boolString
    })
  }),
  ctrl.students
)
router.patch(
  '/students/:studentId',
  adminOnly,
  validate({
    params: z.object({ studentId: objectId }),
    body: z
      .object({
        isActive: z.boolean().optional(),
        name: z.string().trim().min(1).max(120).optional(),
        department: z.string().trim().min(1).max(120).optional(),
        programme: z.string().trim().min(1).max(120).optional()
      })
      .strict()
      .refine((b) => Object.keys(b).length > 0, 'No changes supplied')
  }),
  ctrl.updateStudent
)

router.get(
  '/sessions',
  anyStaff,
  validate({
    query: z.object({
      ...pagination,
      status: z.enum(Object.values(SESSION_STATUS)).optional(),
      studentId: objectId.optional(),
      entryNumber: z.string().trim().max(15).optional(),
      from: isoDate.optional(),
      to: isoDate.optional()
    })
  }),
  ctrl.sessions
)

router.get('/terminals', anyStaff, ctrl.terminals)
router.post(
  '/terminals',
  adminOnly,
  validate({
    body: z.object({
      terminalCode: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9-]{2,40}$/),
      gateType: z.enum(Object.values(GATE_TYPES)),
      name: z.string().trim().min(1).max(80)
    })
  }),
  ctrl.createTerminal
)
router.patch(
  '/terminals/:terminalId',
  adminOnly,
  validate({
    params: z.object({ terminalId: objectId }),
    body: z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        isActive: z.boolean().optional()
      })
      .strict()
      .refine((b) => Object.keys(b).length > 0, 'No changes supplied')
  }),
  ctrl.updateTerminal
)
router.post(
  '/terminals/:terminalId/rotate-key',
  adminOnly,
  validate({ params: z.object({ terminalId: objectId }) }),
  ctrl.rotateTerminalKey
)

router.get(
  '/cards',
  anyStaff,
  validate({
    query: z.object({
      ...pagination,
      entryNumber: z.string().trim().max(15).optional(),
      isActive: boolString
    })
  }),
  ctrl.cards
)
router.post(
  '/cards',
  anyStaff,
  validate({
    body: z.object({
      entryNumber: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9]{6,15}$/),
      cardUid: z.string().trim().min(8).max(64),
      replaceExisting: z.boolean().optional()
    })
  }),
  ctrl.registerCard
)
router.patch(
  '/cards/:cardId/revoke',
  anyStaff,
  validate({
    params: z.object({ cardId: objectId }),
    body: z.object({ reason: z.string().trim().max(200).optional() })
  }),
  ctrl.revokeCard
)

const location = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().min(10),
  height: z.number().min(10),
  zone: z.string().trim().max(60).optional()
})

router.post(
  '/tables',
  adminOnly,
  validate({
    body: z.object({
      tableCode: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9-]{1,20}$/),
      name: z.string().trim().min(1).max(80),
      capacity: z.number().int().min(1).max(20),
      location
    })
  }),
  ctrl.createTable
)
router.patch(
  '/tables/:tableId',
  adminOnly,
  validate({
    params: z.object({ tableId: objectId }),
    body: z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        capacity: z.number().int().min(1).max(20).optional(),
        location: location.optional(),
        isActive: z.boolean().optional()
      })
      .strict()
      .refine((b) => Object.keys(b).length > 0, 'No changes supplied')
  }),
  ctrl.updateTable
)

module.exports = router
