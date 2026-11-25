const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

/** SHA-256 hex, used for storing refresh tokens (high-entropy, so no salt needed). */
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** HMAC with a server-side pepper, used for 6-digit codes (low entropy). */
const hashCode = (code) => crypto.createHmac('sha256', env.OTP_PEPPER).update(code).digest('hex');

/** Constant-time comparison of two hex digests. */
const safeEqual = (a, b) => {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

/** Cryptographically secure 6-digit numeric code. */
const generateCode = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

const generateOpaqueToken = () => crypto.randomBytes(48).toString('base64url');

/**
 * The refresh token that replaces `previous` on rotation. Derived (HMAC with a server secret) rather
 * than random, so a retry with the same old token can be answered with the same new one: the server
 * stores only hashes and could not otherwise hand out the session's current token again.
 */
const nextRefreshToken = (previous) =>
  crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(`refresh-rotation:${previous}`).digest('base64url');

function signAccessToken(user, sessionId) {
  return jwt.sign({ sub: user.id, sid: sessionId, status: user.status }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    issuer: 'papolona-api',
    audience: 'papolona-app',
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'papolona-api', audience: 'papolona-app' });
}

/** Seconds until an access token issued now expires (for the client). */
function accessTokenTtlSeconds() {
  const decoded = jwt.decode(signAccessToken({ id: 'x', status: 'x' }, 'x'));
  return decoded.exp - decoded.iat;
}

module.exports = {
  sha256,
  hashCode,
  safeEqual,
  generateCode,
  generateOpaqueToken,
  nextRefreshToken,
  signAccessToken,
  verifyAccessToken,
  accessTokenTtlSeconds,
};
