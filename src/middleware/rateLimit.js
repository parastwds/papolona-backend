const { rateLimit } = require('express-rate-limit');
const env = require('../config/env');

/**
 * Per-IP limits. Memory store is fine for a single instance; use
 * rate-limit-redis when running more than one API instance.
 */
const make = (windowMinutes, limit, code) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => !env.RATE_LIMIT_ENABLED,
    handler: (_req, res) =>
      res.status(429).json({
        success: false,
        error: { code, message: 'Too many requests. Please wait a few minutes and try again.' },
      }),
  });

module.exports = {
  globalLimiter: make(15, 600, 'RATE_LIMITED'),
  authLimiter: make(15, 30, 'AUTH_RATE_LIMITED'), // login, register, refresh
  resetLimiter: make(15, 10, 'RESET_RATE_LIMITED'), // forgot / verify / reset password
  changeLimiter: make(15, 20, 'CHANGE_RATE_LIMITED'), // email / phone / password change codes (request + confirm)
  clueLimiter: make(15, 60, 'CLUE_RATE_LIMITED'), // each clue is a paid ANU quantum number call
  insightsLimiter: make(15, 60, 'INSIGHTS_RATE_LIMITED'), // journal readings may call the AI model
  messageLimiter: make(15, 300, 'MESSAGE_RATE_LIMITED'), // direct messages and requests
  journalPhotoLimiter: make(15, 60, 'JOURNAL_PHOTO_RATE_LIMITED'), // each journal photo is a Cloudinary upload
};
