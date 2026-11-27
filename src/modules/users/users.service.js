const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const env = require('../../config/env');
const db = require('../../db');
const { DuplicateError } = require('../../db/errors');
const ApiError = require('../../utils/ApiError');
const storage = require('../../utils/storage');
const { templates } = require('../../utils/mailer');
const legalService = require('../app/legal.service');
const sessions = require('../auth/session.service');
const confirmation = require('./confirmation.service');
const journal = require('../journal/journal.service');
const { hashPassword, userPayload, mailSafely } = require('../auth/auth.service');

async function legalStatus(user) {
  const current = await legalService.getCurrentLegalVersions();
  return {
    current,
    accepted: { termsVersion: user.legal?.termsVersion ?? null, privacyVersion: user.legal?.privacyVersion ?? null },
    needsReacceptance:
      user.legal?.termsVersion !== current.termsVersion || user.legal?.privacyVersion !== current.privacyVersion,
  };
}

/** Profile screen + app bootstrap after login. */
async function getMe(user) {
  return { user: await userPayload(user), settings: user.settings, legal: await legalStatus(user) };
}

const DAY = 24 * 60 * 60 * 1000;

/** The first count of passed readings that qualifies from `done` on: at least the minimum, and a multiple of the step. */
function probationTarget(done) {
  const step = env.PROBATION_STEP;
  const from = Math.max(done, env.PROBATION_READINGS);
  return Math.ceil(from / step) * step;
}

/**
 * Home screen: progress through the apprenticeship (probation). It lasts at least PROBATION_DAYS from
 * sign-up, and completes once the readings the AI judge passed are at least PROBATION_READINGS and a
 * multiple of PROBATION_STEP: 30, 33, 36… (31 or 32 wait for 33). Completing does not change the
 * status: the user then joins and chooses a membership.
 */
async function getProbation(user) {
  // A reading counts once the AI judge passes its interpretation.
  const readingsDone = await db.clueDraws.countPassed(user.id);
  const startedAt = new Date(user.createdAt ?? Date.now());
  const daysRequired = env.PROBATION_DAYS;
  const daysDone = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / DAY));
  const readingsTarget = probationTarget(readingsDone);
  const readingsMet = readingsDone === readingsTarget;
  const daysMet = daysDone >= daysRequired;
  return {
    status: user.status,
    readingsDone,
    // The minimum, and the count to reach next (the minimum, or the next multiple of the step above it).
    readingsRequired: env.PROBATION_READINGS,
    readingsStep: env.PROBATION_STEP,
    readingsTarget,
    readingsMet,
    daysDone,
    daysRequired,
    daysMet,
    // When the apprenticeship's days are up.
    endsAt: new Date(startedAt.getTime() + daysRequired * DAY).toISOString(),
    complete: user.status === 'member' || (readingsMet && daysMet),
  };
}

const EMAIL_TAKEN = () => ApiError.conflict('EMAIL_TAKEN', 'Another account already uses this email.');
const PHONE_TAKEN = () => ApiError.conflict('PHONE_TAKEN', 'Another account already uses this phone number.');

/** Edit profile: name and the optional profile fields. Email, phone and password go through an emailed code. */
async function updateProfile(user, changes) {
  const profile = {};
  for (const field of ['bio', 'country', 'timezone']) {
    if (changes[field] !== undefined) profile[field] = changes[field];
  }

  // An external URL (or null) replaces any photo uploaded through the API.
  let replacedPhoto = null;
  if (changes.avatarUrl !== undefined && changes.avatarUrl !== user.profile.avatarUrl) {
    replacedPhoto = user.profile.avatarPublicId;
    profile.avatarUrl = changes.avatarUrl;
    profile.avatarPublicId = null;
  }

  const updated = await db.users.update(user.id, { name: changes.name, profile });
  await storage.removeAvatar(replacedPhoto);
  return { user: await userPayload(updated) };
}

/** Upload or replace the profile photo on Cloudinary; the previous upload is deleted. */
async function uploadAvatar(user, file) {
  const { publicId, url } = await storage.saveAvatar(file.buffer);
  const previous = user.profile.avatarPublicId;
  let updated;
  try {
    updated = await db.users.update(user.id, { profile: { avatarPublicId: publicId, avatarUrl: url } });
  } catch (err) {
    await storage.removeAvatar(publicId);
    throw err;
  }
  await storage.removeAvatar(previous);
  return { user: await userPayload(updated) };
}

async function removeAvatar(user) {
  const previous = user.profile.avatarPublicId;
  const updated = await db.users.update(user.id, { profile: { avatarUrl: null, avatarPublicId: null } });
  await storage.removeAvatar(previous);
  return { user: await userPayload(updated) };
}

async function verifyPassword(userId, password) {
  const withHash = await db.users.findById(userId, { secrets: true });
  const ok = withHash && (await bcrypt.compare(password, withHash.passwordHash));
  if (!ok) throw ApiError.badRequest('PASSWORD_INCORRECT', 'Your current password is not correct.');
}

// ---------------------------------------------------------------- changes confirmed by an emailed code
// Step 1 checks the request and emails a code; nothing changes yet. Step 2 applies the change with that code.

/** Change password, step 1: code goes to the account email. Only the new password's hash is stored meanwhile. */
async function requestPasswordChange(user, { currentPassword, newPassword }, meta) {
  await verifyPassword(user.id, currentPassword);
  if (currentPassword === newPassword) {
    throw ApiError.badRequest('PASSWORD_UNCHANGED', 'Your new password must be different from the current one.');
  }
  return confirmation.sendCode(
    user,
    'password',
    { value: await hashPassword(newPassword), sentTo: user.email, action: 'change your password' },
    meta,
  );
}

/** Change password, step 2. Keeps this device signed in, signs out all others. */
async function confirmPasswordChange(user, sessionId, { code }) {
  const pending = await confirmation.consumeCode(user, 'password', code);
  await db.users.update(user.id, { passwordHash: pending.value, passwordChangedAt: new Date() });
  await sessions.revokeAllForUser(user.id, 'password_changed', sessionId);
  await mailSafely(user.email, templates.passwordChanged(user.name));
  return { message: 'Password updated. Other devices have been signed out.' };
}

/**
 * Change email, step 1: needs the current password, and the code goes to the NEW address,
 * which proves the user owns it (and catches typos) before it becomes their login.
 */
async function requestEmailChange(user, { email, currentPassword }, meta) {
  await verifyPassword(user.id, currentPassword);
  if (email === user.email) throw ApiError.badRequest('EMAIL_UNCHANGED', 'This is already your email.');
  if (await db.users.emailTaken(email)) throw EMAIL_TAKEN();
  return confirmation.sendCode(user, 'email', { value: email, sentTo: email, action: `change your email to ${email}` }, meta);
}

/** Change email, step 2. The new address counts as verified; the old one gets a notice. */
async function confirmEmailChange(user, { code }) {
  const pending = await confirmation.consumeCode(user, 'email', code);
  if (await db.users.emailTaken(pending.value, user.id)) throw EMAIL_TAKEN();
  let updated;
  try {
    updated = await db.users.update(user.id, { email: pending.value, emailVerifiedAt: new Date() });
  } catch (err) {
    if (err instanceof DuplicateError) throw EMAIL_TAKEN();
    throw err;
  }
  await mailSafely(user.email, templates.emailChanged(updated.name, updated.email));
  return { message: 'Your email has been changed.', user: await userPayload(updated) };
}

/** Change or remove (phone: null) the phone number, step 1: code goes to the account email. */
async function requestPhoneChange(user, { phone }, meta) {
  if (phone === user.phone) throw ApiError.badRequest('PHONE_UNCHANGED', 'This is already your phone number.');
  if (phone && (await db.users.phoneTaken(phone))) throw PHONE_TAKEN();
  const action = phone ? `change your phone number to ${phone}` : 'remove your phone number';
  return confirmation.sendCode(user, 'phone', { value: phone, sentTo: user.email, action }, meta);
}

/** Change phone, step 2. */
async function confirmPhoneChange(user, { code }) {
  const pending = await confirmation.consumeCode(user, 'phone', code);
  if (pending.value && (await db.users.phoneTaken(pending.value, user.id))) throw PHONE_TAKEN();
  let updated;
  try {
    updated = await db.users.update(user.id, { phone: pending.value });
  } catch (err) {
    if (err instanceof DuplicateError) throw PHONE_TAKEN();
    throw err;
  }
  await mailSafely(updated.email, templates.phoneChanged(updated.name, updated.phone));
  return {
    message: updated.phone ? 'Your phone number has been changed.' : 'Your phone number has been removed.',
    user: await userPayload(updated),
  };
}

function getSettings(user) {
  return { settings: user.settings };
}

async function updateSettings(user, changes) {
  const updated = await db.users.update(user.id, {
    settings: { notifications: changes.notifications, reminderTime: changes.reminderTime, language: changes.language },
  });
  return { settings: updated.settings };
}

/** Re-accept updated Terms / Privacy (when GET /users/me says needsReacceptance). */
async function acceptLegal(user, { termsVersion, privacyVersion }, meta) {
  const current = await legalService.getCurrentLegalVersions();
  if (termsVersion !== current.termsVersion || privacyVersion !== current.privacyVersion) {
    throw new ApiError(409, 'LEGAL_VERSION_OUTDATED', 'Please accept the latest Terms and Privacy Policy.', current);
  }
  const now = new Date();
  await db.legalAcceptances.createMany([
    { userId: user.id, document: 'terms', version: termsVersion, context: 'reaccept', acceptedAt: now, ip: meta.ip, userAgent: meta.userAgent },
    { userId: user.id, document: 'privacy', version: privacyVersion, context: 'reaccept', acceptedAt: now, ip: meta.ip, userAgent: meta.userAgent },
  ]);
  const updated = await db.users.update(user.id, { legal: { termsVersion, privacyVersion, acceptedAt: now } });
  return { legal: await legalStatus(updated) };
}

const listSessions = (user, sessionId) => sessions.listActive(user.id, sessionId).then((list) => ({ sessions: list }));

async function revokeOneSession(user, targetId) {
  const list = await sessions.listActive(user.id);
  if (!list.some((s) => s.id === targetId)) throw ApiError.notFound('SESSION_NOT_FOUND', 'Device session not found.');
  await sessions.revokeSession(targetId, 'logout');
  return { message: 'Device signed out.' };
}

/**
 * In-app account deletion (required by Apple App Store and GDPR).
 * Personal data is anonymised; pseudonymous research records (cohort,
 * questionnaire answers) are kept unlinked from identity. Confirm this
 * retention rule with the client's privacy policy.
 */
async function deleteAccount(user, { password }) {
  await verifyPassword(user.id, password);
  await db.users.update(user.id, {
    status: 'deleted',
    deletedAt: new Date(),
    name: 'Deleted user',
    email: `deleted+${user.id}@deleted.papolona.invalid`,
    phone: null,
    passwordHash: crypto.randomBytes(32).toString('hex'),
    profile: { bio: '', country: null, timezone: null, avatarUrl: null, avatarPublicId: null },
    settings: { notifications: { marketing: false, productUpdates: false } },
  });
  await sessions.revokeAllForUser(user.id, 'account_deleted');
  await journal.deleteAllForUser(user.id); // private writing is not kept as research data
  await storage.removeAvatar(user.profile?.avatarPublicId);
  return { message: 'Your account has been deleted.' };
}

module.exports = {
  getMe,
  getProbation,
  updateProfile,
  uploadAvatar,
  removeAvatar,
  requestPasswordChange,
  confirmPasswordChange,
  requestEmailChange,
  confirmEmailChange,
  requestPhoneChange,
  confirmPhoneChange,
  getSettings,
  updateSettings,
  acceptLegal,
  listSessions,
  revokeOneSession,
  deleteAccount,
};
