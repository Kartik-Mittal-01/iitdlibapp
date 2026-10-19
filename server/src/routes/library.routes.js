const { Router } = require('express')
const ctrl = require('../controllers/libraryController')
const { authenticate } = require('../middleware/auth')
const { validate, z, objectId } = require('../middleware/validate')

const router = Router()

// Map data is available to any signed-in student, staff member or gate terminal.
const anyPrincipal = authenticate('student', 'staff', 'terminal')

router.get('/map', anyPrincipal, ctrl.map)
router.get('/occupancy', anyPrincipal, ctrl.occupancy)
router.get('/tables', anyPrincipal, ctrl.tables)
router.get(
  '/tables/:tableId/seats',
  anyPrincipal,
  validate({ params: z.object({ tableId: objectId }) }),
  ctrl.tableSeats
)

router.post(
  '/seats/allocate',
  authenticate('staff'),
  validate({
    body: z
      .object({
        entryNumber: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9]{6,15}$/),
        terminalCode: z.string().trim().min(2).max(40),
        tableId: objectId.optional(),
        seatId: objectId.optional()
      })
      .refine((b) => b.tableId || b.seatId, 'tableId or seatId is required')
  }),
  ctrl.allocateSeat
)

module.exports = router
