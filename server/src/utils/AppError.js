const { errorMessage } = require('../shared')

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message || errorMessage(code))
    this.status = status
    this.code = code
    this.details = details
    // Retryable errors leave a gate scan usable (e.g. the chosen seat was taken).
    this.retryable = false
  }

  static badRequest(code, message, details) {
    return new AppError(400, code, message, details)
  }
  static unauthorized(code = 'UNAUTHENTICATED', message) {
    return new AppError(401, code, message)
  }
  static forbidden(code = 'FORBIDDEN', message) {
    return new AppError(403, code, message)
  }
  static notFound(code = 'NOT_FOUND', message) {
    return new AppError(404, code, message)
  }
  static conflict(code, message, details) {
    return new AppError(409, code, message, details)
  }
  static gone(code, message) {
    return new AppError(410, code, message)
  }
  asRetryable() {
    this.retryable = true
    return this
  }
}

module.exports = AppError
