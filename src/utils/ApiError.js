/**
 * Operational error with an HTTP status and a stable machine-readable code.
 * The mobile app should switch on `code`, never on `message`.
 */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(code, message, details) {
    return new ApiError(400, code, message, details);
  }
  static unauthorized(code = 'UNAUTHORIZED', message = 'Authentication required.') {
    return new ApiError(401, code, message);
  }
  static forbidden(code = 'FORBIDDEN', message = 'You do not have access to this resource.') {
    return new ApiError(403, code, message);
  }
  static notFound(code = 'NOT_FOUND', message = 'Resource not found.') {
    return new ApiError(404, code, message);
  }
  static conflict(code, message) {
    return new ApiError(409, code, message);
  }
  static tooMany(code, message, details) {
    return new ApiError(429, code, message, details);
  }
}

module.exports = ApiError;
