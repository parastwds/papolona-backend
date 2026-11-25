const env = require('../../config/env');
const db = require('../../db');
const ApiError = require('../../utils/ApiError');
const { templates } = require('../../utils/mailer');
const { hashCode, safeEqual, generateCode } = require('../../utils/security');
const { mailSafely } = require('../auth/auth.service');

// Uses the same lifetime, attempt limit and resend cooldown as password-reset codes.

/** "asha.verma@example.com" -> "as********@example.com" */
function maskEmail(email) {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/**
 * Stores a pending change and emails its 6-digit code to `sentTo`.
 * Replaces any earlier pending change of the same type.
 */
async function sendCode(user, type, { value, sentTo, action }, meta) {
  // Cooldown applies to resending a code that is still waiting, not to a new change after one was confirmed.
  const recent = await db.pendingChanges.findRecent(user.id, type, new Date(Date.now() - env.RESET_CODE_RESEND_SECONDS * 1000));
  if (recent) {
    const retryAfterSeconds = Math.ceil((recent.createdAt.getTime() + env.RESET_CODE_RESEND_SECONDS * 1000 - Date.now()) / 1000);
    throw ApiError.tooMany('CODE_RECENTLY_SENT', 'A code was just sent. Please wait before asking for another.', { retryAfterSeconds });
  }

  await db.pendingChanges.invalidateActive(user.id, type);

  const code = generateCode();
  await db.pendingChanges.create({
    userId: user.id,
    type,
    value,
    codeHash: hashCode(code),
    sentTo,
    expiresAt: new Date(Date.now() + env.RESET_CODE_TTL_MINUTES * 60 * 1000),
    ip: meta.ip,
  });

  await mailSafely(sentTo, templates.changeCode(user.name, code, env.RESET_CODE_TTL_MINUTES, action));
  return {
    message: `We sent a 6-digit code to ${maskEmail(sentTo)}. Enter it to confirm the change.`,
    sentTo: maskEmail(sentTo),
    expiresInMinutes: env.RESET_CODE_TTL_MINUTES,
    resendAfterSeconds: env.RESET_CODE_RESEND_SECONDS,
  };
}

const INVALID_CODE = () => ApiError.badRequest('CODE_INVALID', 'This code is invalid or has expired. Request a new one.');

/**
 * Checks the code for the user's active change of `type` and marks it used.
 * Wrong codes count down; after the limit the change is cancelled.
 * A change requested before the latest password change (e.g. a reset) is no longer valid.
 */
async function consumeCode(user, type, code) {
  const pending = await db.pendingChanges.findActive(user.id, type);
  if (!pending) throw INVALID_CODE();

  if (user.passwordChangedAt && pending.createdAt < user.passwordChangedAt) {
    await db.pendingChanges.invalidate(pending.id);
    throw INVALID_CODE();
  }

  if (pending.attempts >= env.RESET_CODE_MAX_ATTEMPTS) {
    await db.pendingChanges.invalidate(pending.id);
    throw INVALID_CODE();
  }

  if (!safeEqual(hashCode(code), pending.codeHash)) {
    const attempts = await db.pendingChanges.addAttempt(pending.id);
    const remaining = Math.max(0, env.RESET_CODE_MAX_ATTEMPTS - attempts);
    if (remaining === 0) await db.pendingChanges.invalidate(pending.id);
    throw ApiError.badRequest('CODE_INVALID', 'This code is not correct.', { attemptsRemaining: remaining });
  }

  // Atomic, so the same code cannot be used twice by parallel requests.
  const consumed = await db.pendingChanges.consume(pending.id);
  if (!consumed) throw INVALID_CODE();
  return pending;
}

module.exports = { sendCode, consumeCode, maskEmail };
