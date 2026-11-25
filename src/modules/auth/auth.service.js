const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const env = require('../../config/env');
const db = require('../../db');
const { DuplicateError } = require('../../db/errors');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { sendMail, templates } = require('../../utils/mailer');
const google = require('../../utils/google');
const { hashCode, safeEqual, generateCode } = require('../../utils/security');
const legalService = require('../app/legal.service');
const onboardingService = require('../onboarding/onboarding.service');
const sessions = require('./session.service');
const { isLocked, toPublicUser } = require('../users/userShape');

// Compared against when the email is unknown, so response time does not reveal whether an account exists.
const DUMMY_HASH = bcrypt.hashSync('papolona-timing-guard', env.BCRYPT_ROUNDS);

const hashPassword = (pw) => bcrypt.hash(pw, env.BCRYPT_ROUNDS);

/**
 * Sends an email and never throws: a mail outage must not fail the request.
 * Callers await it so the send finishes before the response. On serverless hosts (Vercel) the function is
 * frozen once it responds, which would otherwise cut off emails, including codes, part-way through.
 */
const mailSafely = (to, tpl) => sendMail({ to, ...tpl }).catch((e) => logger.error('Mail send failed', e));

// forgot-password waits for the email only when the account exists, so every response is padded to at least
// this long; otherwise the extra send time would reveal which emails are registered.
const FORGOT_MIN_RESPONSE_MS = env.NODE_ENV === 'test' ? 0 : 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function userPayload(user) {
  return { ...toPublicUser(user, { showCohort: false }), cohortDetails: await onboardingService.cohortForUser(user) };
}

const PHONE_TAKEN = () => ApiError.conflict('PHONE_TAKEN', 'Another account already uses this mobile number.');

// ---------------------------------------------------------------- register

async function register(input, meta) {
  return createAccount(
    { name: input.name, email: input.email, phone: input.phone, passwordHash: await hashPassword(input.password) },
    input.questionnaireSubmissionId,
    meta,
  );
}

/**
 * Creates an account from a questionnaire submission (cohort, legal acceptance, session, welcome mail).
 * Shared by email registration and first-time Google sign-in. Every account starts with a mobile number.
 */
async function createAccount(fields, questionnaireSubmissionId, meta) {
  // Registering implies acceptance of the currently published Terms and Privacy Policy.
  const current = await legalService.getCurrentLegalVersions();

  const submission = await db.submissions.findById(questionnaireSubmissionId);
  if (!submission) throw ApiError.badRequest('QUESTIONNAIRE_INVALID', 'Please complete the questionnaire before registering.');
  if (submission.linkedUserId) throw ApiError.conflict('QUESTIONNAIRE_ALREADY_USED', 'Please complete the questionnaire again.');

  if (await db.users.emailTaken(fields.email)) {
    throw ApiError.conflict('EMAIL_TAKEN', 'An account with this email already exists. Try logging in instead.');
  }
  if (await db.users.phoneTaken(fields.phone)) throw PHONE_TAKEN();

  const now = new Date();
  let user;
  try {
    user = await db.users.create({
      ...fields,
      cohort: submission.cohort,
      readinessTier: submission.readinessTier,
      segmentTags: submission.tags,
      questionnaireSubmission: submission.id,
      legal: { termsVersion: current.termsVersion, privacyVersion: current.privacyVersion, acceptedAt: now },
    });
  } catch (err) {
    // Lost a race with another sign-up: say which of the two unique values it was.
    if (err instanceof DuplicateError) {
      if (await db.users.phoneTaken(fields.phone)) throw PHONE_TAKEN();
      throw ApiError.conflict('EMAIL_TAKEN', 'An account with this email already exists. Try logging in instead.');
    }
    throw err;
  }

  // Link atomically so one submission can never be claimed by two accounts.
  const linked = await db.submissions.linkToUser(submission.id, user.id, now);
  if (!linked) {
    await db.users.remove(user.id);
    throw ApiError.conflict('QUESTIONNAIRE_ALREADY_USED', 'Please complete the questionnaire again.');
  }

  await db.legalAcceptances.createMany([
    { userId: user.id, document: 'terms', version: current.termsVersion, context: 'register', acceptedAt: now, ip: meta.ip, userAgent: meta.userAgent },
    { userId: user.id, document: 'privacy', version: current.privacyVersion, context: 'register', acceptedAt: now, ip: meta.ip, userAgent: meta.userAgent },
  ]);

  const tokens = await sessions.createSession(user, meta);
  await mailSafely(user.email, templates.welcome(user.name));
  return { user: await userPayload(user), tokens };
}

// ---------------------------------------------------------------- google

/**
 * Sign in or sign up with a Google ID token from the app.
 * 1. Known Google account → log in.
 * 2. Existing account with the same (Google-verified) email → link Google, log in.
 * 3. Otherwise create an account, which needs a questionnaire submission like email sign-up;
 *    without one, ACCOUNT_NOT_FOUND tells the app to send the user to the questionnaire.
 *    It also needs a mobile number, which Google does not share: PHONE_REQUIRED asks the app for it.
 */
async function googleSignIn({ idToken, questionnaireSubmissionId, phone }, meta) {
  const claims = await google.verifyIdToken(idToken);
  if (!claims?.sub || !claims.email) throw ApiError.unauthorized('GOOGLE_TOKEN_INVALID', 'Google sign-in failed. Please try again.');
  if (claims.email_verified !== true) {
    throw ApiError.forbidden('GOOGLE_EMAIL_UNVERIFIED', 'Your Google email address is not verified.');
  }
  const email = claims.email.toLowerCase();
  const identity = { provider: 'google', providerId: claims.sub, email, linkedAt: new Date() };

  let user = await db.users.findByIdentity('google', claims.sub);
  if (!user) {
    user = await db.users.findByEmail(email);
    if (user && user.status !== 'deleted') {
      // Google vouches for this email, so it is safe to attach it to the account that owns the address.
      await db.users.addIdentity(user.id, identity);
      if (!user.emailVerifiedAt) await db.users.update(user.id, { emailVerifiedAt: new Date() });
      user = await db.users.findById(user.id);
    }
  }

  if (user && user.status !== 'deleted') {
    if (user.status === 'suspended') throw ApiError.forbidden('ACCOUNT_SUSPENDED', 'This account has been suspended.');
    await db.users.update(user.id, { failedLoginAttempts: 0, lockUntil: null, lastLoginAt: new Date() });
    const tokens = await sessions.createSession(user, meta);
    return { user: await userPayload(user), tokens, created: false };
  }

  if (!questionnaireSubmissionId) {
    throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'There is no Papolona account for this Google account yet.');
  }
  if (!phone) throw ApiError.badRequest('PHONE_REQUIRED', 'Enter your mobile number to create your account.');
  const result = await createAccount(
    {
      name: (claims.name || email.split('@')[0]).slice(0, 80),
      email,
      phone,
      // Random and never revealed: password login fails until the user sets one via forgot-password.
      passwordHash: await hashPassword(crypto.randomBytes(32).toString('hex')),
      emailVerifiedAt: new Date(),
      identities: [identity],
    },
    questionnaireSubmissionId,
    meta,
  );
  return { ...result, created: true };
}

// ---------------------------------------------------------------- login

async function login({ email, password }, meta) {
  const user = await db.users.findByEmail(email, { secrets: true });

  if (!user || user.status === 'deleted') {
    await bcrypt.compare(password, DUMMY_HASH);
    throw ApiError.unauthorized('INVALID_CREDENTIALS', 'Incorrect email or password.');
  }

  if (isLocked(user)) {
    const retryAfterSeconds = Math.ceil((user.lockUntil - Date.now()) / 1000);
    throw ApiError.tooMany('ACCOUNT_LOCKED', 'Too many failed attempts. Please try again later or reset your password.', { retryAfterSeconds });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const attempts = (user.failedLoginAttempts || 0) + 1;
    if (attempts >= env.LOGIN_MAX_FAILED_ATTEMPTS) {
      const lockUntil = new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60 * 1000);
      await db.users.update(user.id, { failedLoginAttempts: 0, lockUntil });
      throw ApiError.tooMany('ACCOUNT_LOCKED', 'Too many failed attempts. Please try again later or reset your password.', {
        retryAfterSeconds: env.LOGIN_LOCK_MINUTES * 60,
      });
    }
    await db.users.update(user.id, { failedLoginAttempts: attempts });
    throw ApiError.unauthorized('INVALID_CREDENTIALS', 'Incorrect email or password.');
  }

  if (user.status === 'suspended') throw ApiError.forbidden('ACCOUNT_SUSPENDED', 'This account has been suspended.');

  await db.users.update(user.id, { failedLoginAttempts: 0, lockUntil: null, lastLoginAt: new Date() });
  const tokens = await sessions.createSession(user, meta);
  return { user: await userPayload(user), tokens };
}

// ---------------------------------------------------------------- refresh / logout

async function refresh({ refreshToken }, meta) {
  const { tokens } = await sessions.rotate(refreshToken, meta);
  return { tokens };
}

const logout = (sessionId) => sessions.revokeSession(sessionId, 'logout');
const logoutAll = (userId) => sessions.revokeAllForUser(userId, 'logout_all');

// ---------------------------------------------------------------- password reset

// Accounts that may reset a password: not suspended or deleted.
const RESETTABLE_STATUSES = ['probation', 'member'];

const RESET_RESPONSE = {
  message: 'If an account exists for this email, a 6-digit code has been sent.',
  resendAfterSeconds: env.RESET_CODE_RESEND_SECONDS,
  expiresInMinutes: env.RESET_CODE_TTL_MINUTES,
};

/** Always returns the same response, padded to the same minimum time, so the form cannot be used to discover accounts. */
async function forgotPassword(input, meta) {
  const started = Date.now();
  try {
    return await sendResetCode(input, meta);
  } finally {
    await sleep(Math.max(0, FORGOT_MIN_RESPONSE_MS - (Date.now() - started)));
  }
}

async function sendResetCode({ email }, meta) {
  const user = await db.users.findByEmail(email, { statuses: RESETTABLE_STATUSES });
  if (!user) return RESET_RESPONSE;

  const recent = await db.passwordResets.findRecent(user.id, new Date(Date.now() - env.RESET_CODE_RESEND_SECONDS * 1000));
  if (recent) return RESET_RESPONSE; // resend cooldown

  await db.passwordResets.invalidateActive(user.id);

  const code = generateCode();
  await db.passwordResets.create({
    userId: user.id,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + env.RESET_CODE_TTL_MINUTES * 60 * 1000),
    ip: meta.ip,
  });

  await mailSafely(user.email, templates.resetCode(user.name, code, env.RESET_CODE_TTL_MINUTES));
  return RESET_RESPONSE;
}

const INVALID_CODE = () => ApiError.badRequest('RESET_CODE_INVALID', 'This code is invalid or has expired. Request a new one.');

/** Finds the active reset and checks the code, counting failed attempts. Does not consume it. */
async function checkCode(email, code) {
  const user = await db.users.findByEmail(email, { statuses: RESETTABLE_STATUSES });
  if (!user) throw INVALID_CODE();

  const reset = await db.passwordResets.findActive(user.id);
  if (!reset) throw INVALID_CODE();

  if (reset.attempts >= env.RESET_CODE_MAX_ATTEMPTS) {
    await db.passwordResets.invalidate(reset.id);
    throw INVALID_CODE();
  }

  if (!safeEqual(hashCode(code), reset.codeHash)) {
    const attempts = await db.passwordResets.addAttempt(reset.id);
    const remaining = Math.max(0, env.RESET_CODE_MAX_ATTEMPTS - attempts);
    if (remaining === 0) await db.passwordResets.invalidate(reset.id);
    throw ApiError.badRequest('RESET_CODE_INVALID', 'This code is not correct.', { attemptsRemaining: remaining });
  }

  return { user, reset };
}

async function verifyResetCode({ email, code }) {
  await checkCode(email, code);
  return { valid: true };
}

async function resetPassword({ email, code, newPassword }) {
  const { user, reset } = await checkCode(email, code);

  const consumed = await db.passwordResets.consume(reset.id);
  if (!consumed) throw INVALID_CODE();

  await db.users.update(user.id, {
    passwordHash: await hashPassword(newPassword),
    passwordChangedAt: new Date(),
    failedLoginAttempts: 0,
    lockUntil: null,
  });
  await sessions.revokeAllForUser(user.id, 'password_reset');
  await mailSafely(user.email, templates.passwordChanged(user.name));

  return { message: 'Your password has been updated. Please log in with your new password.' };
}

module.exports = {
  register,
  googleSignIn,
  login,
  refresh,
  logout,
  logoutAll,
  forgotPassword,
  verifyResetCode,
  resetPassword,
  hashPassword,
  userPayload,
  mailSafely,
};
