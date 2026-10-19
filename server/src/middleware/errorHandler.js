const mongoose = require('mongoose')
const AppError = require('../utils/AppError')
const { errorMessage } = require('../shared')

function notFound(req, _res, next) {
  next(AppError.notFound('NOT_FOUND', `No route for ${req.method} ${req.path}`))
}

function errorHandler(err, req, res, _next) {
  let e = err
  if (!(e instanceof AppError)) {
    if (err.type === 'entity.parse.failed')
      e = AppError.badRequest('VALIDATION_ERROR', 'Malformed JSON body.')
    else if (err.type === 'entity.too.large')
      e = new AppError(413, 'VALIDATION_ERROR', 'Request body too large.')
    else if (err instanceof mongoose.Error.CastError)
      e = AppError.badRequest('VALIDATION_ERROR', `Invalid ${err.path}.`)
    else if (err instanceof mongoose.Error.ValidationError) {
      e = AppError.badRequest(
        'VALIDATION_ERROR',
        undefined,
        Object.values(err.errors).map((v) => ({ path: v.path, message: v.message }))
      )
    } else if (err.code === 11000)
      e = AppError.conflict('CONFLICT', 'A record with these values already exists.')
    else if (err.message === 'Not allowed by CORS')
      e = AppError.forbidden('FORBIDDEN', 'Origin not allowed.')
    else if (
      err instanceof mongoose.Error.MongooseServerSelectionError ||
      err.name === 'MongoNetworkError' ||
      err.name === 'MongoServerSelectionError'
    ) {
      e = new AppError(503, 'SERVICE_UNAVAILABLE')
    } else {
      e = new AppError(500, 'INTERNAL_ERROR')
    }
  }

  if (e.status >= 500) {
    // Log server-side only; clients never see stacks or internal messages.
    console.error(`[error] ${req.method} ${req.originalUrl}:`, err.stack || err.message)
  }

  const body = {
    success: false,
    error: { code: e.code, message: e.message || errorMessage(e.code) }
  }
  if (e.details !== undefined) body.error.details = e.details
  res.status(e.status).json(body)
}

module.exports = { notFound, errorHandler }
