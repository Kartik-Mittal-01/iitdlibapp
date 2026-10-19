const { z } = require('zod')
const AppError = require('../utils/AppError')

/**
 * Validates request parts against zod schemas. Parsed values are placed on
 * req.valid.{body,query,params} (Express 5 makes req.query read-only).
 */
function validate(schemas) {
  return (req, _res, next) => {
    req.valid = req.valid || {}
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue
      const result = schemas[part].safeParse(req[part] ?? {})
      if (!result.success) {
        throw AppError.badRequest(
          'VALIDATION_ERROR',
          undefined,
          result.error.issues.map((i) => ({
            path: [part, ...i.path].join('.'),
            message: i.message
          }))
        )
      }
      req.valid[part] = result.data
    }
    next()
  }
}

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id')
const isoDate = z.iso.datetime({ offset: true }).or(z.iso.date())
const boolString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional()
const pagination = {
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
}

module.exports = { validate, z, objectId, isoDate, boolString, pagination }
