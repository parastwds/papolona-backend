const ApiError = require('../utils/ApiError');
const { verifyAccessToken } = require('../utils/security');
const db = require('../db');

/**
 * Requires a valid Bearer access token whose session is still active.
 * Sets req.user and req.sessionId.
 *
 * The session lookup means logout / password change take effect immediately,
 * not only when the 15-minute access token expires.
 */
async function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw ApiError.unauthorized('TOKEN_MISSING', 'Authentication required.');

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw ApiError.unauthorized('TOKEN_EXPIRED', 'Your session has expired.');
    throw ApiError.unauthorized('TOKEN_INVALID', 'Invalid authentication token.');
  }

  // A token from the other database (after switching DATABASE_URL) has ids in the wrong format: treat it as signed out.
  if (!db.isValidId(payload.sub) || !db.isValidId(payload.sid)) {
    throw ApiError.unauthorized('SESSION_REVOKED', 'You have been signed out. Please log in again.');
  }

  const [user, sessionActive] = await Promise.all([db.users.findById(payload.sub), db.sessions.isActive(payload.sid, payload.sub)]);

  if (!sessionActive) throw ApiError.unauthorized('SESSION_REVOKED', 'You have been signed out. Please log in again.');
  if (!user || user.status === 'deleted') throw ApiError.unauthorized('ACCOUNT_UNAVAILABLE', 'This account is no longer available.');
  if (user.status === 'suspended') throw ApiError.forbidden('ACCOUNT_SUSPENDED', 'This account has been suspended.');

  req.user = user;
  req.sessionId = payload.sid;
  next();
}

module.exports = { requireAuth };
