const { ZodError } = require('zod');
const db = require('../db');
const { DuplicateError } = require('../db/errors');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const env = require('../config/env');

function notFound(req, _res, next) {
  next(ApiError.notFound('ROUTE_NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found.`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let error = err;

  if (err instanceof ZodError) {
    // One message per field (the first failing rule), which is what a form shows.
    const byField = new Map();
    for (const i of err.issues) {
      const field = i.path.join('.') || '_';
      if (!byField.has(field)) byField.set(field, i.message);
    }
    const details = [...byField].map(([field, message]) => ({ field, message }));
    error = ApiError.badRequest('VALIDATION_ERROR', 'Some fields are missing or invalid.', details);
  } else if (err?.type === 'entity.parse.failed') {
    error = ApiError.badRequest('INVALID_JSON', 'Request body is not valid JSON.');
  } else if (err?.type === 'entity.too.large') {
    error = new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  } else if (db.isInvalidIdError(err)) {
    error = ApiError.badRequest('INVALID_ID', 'Invalid id.');
  } else if (err instanceof DuplicateError) {
    error = ApiError.conflict('DUPLICATE', 'A record with these details already exists.');
  }

  if (!(error instanceof ApiError)) {
    logger.error(`${req.method} ${req.originalUrl}`, err);
    error = new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong on our side. Please try again.');
    if (env.NODE_ENV !== 'production') error.details = { message: err?.message };
  }

  res.status(error.status).json({
    success: false,
    error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
  });
}

module.exports = { notFound, errorHandler };
