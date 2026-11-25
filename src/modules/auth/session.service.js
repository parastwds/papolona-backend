const crypto = require('crypto');
const env = require('../../config/env');
const db = require('../../db');
const ApiError = require('../../utils/ApiError');
const {
  sha256,
  generateOpaqueToken,
  nextRefreshToken,
  signAccessToken,
  accessTokenTtlSeconds,
} = require('../../utils/security');

const ACCESS_TTL_SECONDS = accessTokenTtlSeconds();
const refreshExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

function tokenPair(user, sessionId, refreshToken) {
  return {
    accessToken: signAccessToken(user, sessionId),
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TTL_SECONDS,
  };
}

/** New login on a device. */
async function createSession(user, meta) {
  const refreshToken = generateOpaqueToken();
  const session = await db.sessions.create({
    userId: user.id,
    family: crypto.randomUUID(),
    tokenHash: sha256(refreshToken),
    expiresAt: refreshExpiry(),
    ip: meta.ip,
    userAgent: meta.userAgent,
    platform: meta.platform,
    appVersion: meta.appVersion,
  });
  return tokenPair(user, session.id, refreshToken);
}

/**
 * A retry of the session's most recent rotation: the token presented is the one that rotation retired,
 * it happened within the grace window, and the session's current token is the one derived from it.
 * Answers with that same current token, so a client that lost the response (crash, reload, two
 * requests racing) and a client that saved it both end up holding the token the server expects.
 */
async function findRetriedRotation(refreshToken, hash, now) {
  const graceMs = env.REFRESH_REUSE_GRACE_SECONDS * 1000;
  if (!graceMs) return null;
  const session = await db.sessions.findJustRotated(hash, new Date(now.getTime() - graceMs), now);
  const currentToken = nextRefreshToken(refreshToken);
  if (!session || session.tokenHash !== sha256(currentToken)) return null;
  return { session, currentToken };
}

/**
 * Exchange a refresh token for a new pair (rotation).
 * Presenting the just-retired token again within REFRESH_REUSE_GRACE_SECONDS returns the current
 * token again (see findRetriedRotation). Presenting any other already-rotated token revokes every
 * session in that family.
 */
async function rotate(refreshToken, meta) {
  const hash = sha256(refreshToken);
  const now = new Date();
  let newToken = nextRefreshToken(refreshToken);

  let session = await db.sessions.rotate({
    tokenHash: hash,
    newTokenHash: sha256(newToken),
    now,
    expiresAt: refreshExpiry(),
    ip: meta.ip,
  });

  if (!session) {
    const retried = await findRetriedRotation(refreshToken, hash, now);
    if (retried) ({ session, currentToken: newToken } = retried);
  }

  if (!session) {
    const reused = await db.sessions.findByPreviousToken(hash);
    if (reused) {
      await db.sessions.revokeFamily(reused.family, 'token_reuse', now);
      throw ApiError.unauthorized('REFRESH_TOKEN_REUSED', 'For your security you have been signed out. Please log in again.');
    }
    throw ApiError.unauthorized('REFRESH_TOKEN_INVALID', 'Your session has expired. Please log in again.');
  }

  const user = await db.users.findById(session.userId);
  if (!user || user.status === 'deleted') {
    await revokeSession(session.id, 'account_deleted');
    throw ApiError.unauthorized('ACCOUNT_UNAVAILABLE', 'This account is no longer available.');
  }
  if (user.status === 'suspended') throw ApiError.forbidden('ACCOUNT_SUSPENDED', 'This account has been suspended.');

  return { user, tokens: tokenPair(user, session.id, newToken) };
}

async function revokeSession(sessionId, reason) {
  await db.sessions.revoke(sessionId, reason);
}

/** Revoke all of a user's sessions, optionally keeping the current one. */
async function revokeAllForUser(userId, reason, exceptSessionId) {
  await db.sessions.revokeAllForUser(userId, reason, exceptSessionId);
}

async function listActive(userId, currentSessionId) {
  const sessions = await db.sessions.listActive(userId);
  return sessions.map((s) => ({
    id: s.id,
    platform: s.platform,
    appVersion: s.appVersion,
    userAgent: s.userAgent,
    lastUsedAt: s.lastUsedAt,
    createdAt: s.createdAt,
    current: s.id === currentSessionId,
  }));
}

module.exports = { createSession, rotate, revokeSession, revokeAllForUser, listActive };
