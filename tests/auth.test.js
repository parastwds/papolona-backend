const { sql } = require('drizzle-orm');
const db = require('../src/db');
const { db: drizzle } = require('../src/db/postgres/connection');
const {
  setupDB,
  resetData,
  teardownDB,
  api,
  submitQuestionnaire,
  registerUser,
  bearer,
  lastResetCode,
  outbox,
  PASSWORD,
} = require('./helpers');

beforeAll(() => setupDB('auth'));
beforeEach(resetData);
afterAll(teardownDB);

const baseRegister = async (overrides = {}) => ({
  name: 'Asha Verma',
  email: 'asha@example.com',
  password: PASSWORD,
  phone: '+919812345678',
  questionnaireSubmissionId: await submitQuestionnaire(),
  ...overrides,
});

describe('POST /auth/register', () => {
  test('creates a probation account with cohort, legal record, tokens and welcome mail', async () => {
    const res = await api().post('/api/v1/auth/register').send(await baseRegister({ email: '  Asha@Example.COM ' }));
    expect(res.status).toBe(201);

    const { user, tokens } = res.body.data;
    expect(user.email).toBe('asha@example.com');
    expect(user.phone).toBe('+919812345678');
    expect(user.status).toBe('probation');
    expect(user.cohortDetails).toBeNull(); // cohort is internal only
    expect(user).not.toHaveProperty('cohort');
    expect(user.legal.termsVersion).toBe('1.0');
    expect(user).not.toHaveProperty('passwordHash');
    expect(tokens.tokenType).toBe('Bearer');
    expect(tokens.expiresIn).toBe(900);

    const acceptances = await db.legalAcceptances.listForUser(user.id);
    expect(acceptances.map((a) => a.document).sort()).toEqual(['privacy', 'terms']);

    const stored = await db.users.findById(user.id);
    const submission = await db.submissions.findById(stored.questionnaireSubmission);
    expect(submission.linkedUserId).toBe(user.id);

    await new Promise((r) => setImmediate(r));
    expect(outbox.some((m) => m.to === 'asha@example.com' && /welcome/i.test(m.subject))).toBe(true);
  });

  test('duplicate email -> 409 EMAIL_TAKEN', async () => {
    await api().post('/api/v1/auth/register').send(await baseRegister());
    const res = await api().post('/api/v1/auth/register').send(await baseRegister());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  test('a questionnaire submission can only be used once', async () => {
    const body = await baseRegister();
    await api().post('/api/v1/auth/register').send(body);
    const res = await api().post('/api/v1/auth/register').send({ ...body, email: 'other@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('QUESTIONNAIRE_ALREADY_USED');
  });

  test('unknown submission -> QUESTIONNAIRE_INVALID', async () => {
    const res = await api()
      .post('/api/v1/auth/register')
      .send(await baseRegister({ questionnaireSubmissionId: db.testing.unknownId() }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('QUESTIONNAIRE_INVALID');
  });

  test('validation: weak password, bad email', async () => {
    const res = await api()
      .post('/api/v1/auth/register')
      .send(await baseRegister({ password: 'short', email: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d) => d.field).sort()).toEqual(['email', 'password']);
  });

  test('a mobile number with a real country code is required', async () => {
    const register = (body) => api().post('/api/v1/auth/register').send(body);
    const fieldsOf = (res) => res.body.error.details.map((d) => d.field);

    const { phone, ...withoutPhone } = await baseRegister();
    expect(fieldsOf(await register(withoutPhone))).toEqual(['phone']);
    expect(fieldsOf(await register({ ...withoutPhone, phone: '9812345678' }))).toEqual(['phone']); // no country code
    const unknownCode = await register({ ...withoutPhone, phone: '+999 12345678' });
    expect(unknownCode.status).toBe(400);
    expect(unknownCode.body.error.details[0].message).toMatch(/country code is not recognised/);
    expect(await db.testing.countUsers()).toBe(0);

    // Spaces and dashes are fine; the stored number is E.164.
    const ok = await register({ ...withoutPhone, phone: '+91 98123-45678' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.user.phone).toBe(phone);
  });

  test('duplicate mobile number -> 409 PHONE_TAKEN', async () => {
    await api().post('/api/v1/auth/register').send(await baseRegister());
    const res = await api().post('/api/v1/auth/register').send(await baseRegister({ email: 'other@example.com' }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PHONE_TAKEN');
    expect(await db.testing.countUsers()).toBe(1);
  });

  test('passwords longer than 72 characters are rejected', async () => {
    const res = await api().post('/api/v1/auth/register').send(await baseRegister({ password: `a1${'x'.repeat(80)}` }));
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/login', () => {
  test('logs in with any email casing', async () => {
    const { user } = await registerUser({ email: 'login@example.com' });
    const res = await api().post('/api/v1/auth/login').send({ email: 'LOGIN@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.id);
    expect(res.body.data.tokens.accessToken).toBeTruthy();
  });

  test('wrong password and unknown email give the same error', async () => {
    await registerUser({ email: 'login@example.com' });
    const a = await api().post('/api/v1/auth/login').send({ email: 'login@example.com', password: 'Wrongpass1' });
    const b = await api().post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'Wrongpass1' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toEqual(b.body.error);
  });

  test('rejects objects where strings are expected (operator injection)', async () => {
    const res = await api().post('/api/v1/auth/login').send({ email: { $gt: '' }, password: { $gt: '' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('locks the account after 5 failed attempts, even for the right password', async () => {
    await registerUser({ email: 'lock@example.com' });
    for (let i = 0; i < 4; i += 1) {
      const r = await api().post('/api/v1/auth/login').send({ email: 'lock@example.com', password: 'Wrongpass1' });
      expect(r.status).toBe(401);
    }
    const fifth = await api().post('/api/v1/auth/login').send({ email: 'lock@example.com', password: 'Wrongpass1' });
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(fifth.body.error.details.retryAfterSeconds).toBeGreaterThan(0);

    const correct = await api().post('/api/v1/auth/login').send({ email: 'lock@example.com', password: PASSWORD });
    expect(correct.status).toBe(429);
  });

  test('successful login resets the failed-attempt counter', async () => {
    await registerUser({ email: 'count@example.com' });
    for (let i = 0; i < 4; i += 1) {
      await api().post('/api/v1/auth/login').send({ email: 'count@example.com', password: 'Wrongpass1' });
    }
    expect((await api().post('/api/v1/auth/login').send({ email: 'count@example.com', password: PASSWORD })).status).toBe(200);
    const again = await api().post('/api/v1/auth/login').send({ email: 'count@example.com', password: 'Wrongpass1' });
    expect(again.status).toBe(401);
  });

  test('suspended account cannot log in', async () => {
    const { user } = await registerUser({ email: 'sus@example.com' });
    await db.users.update(user.id, { status: 'suspended' });
    const res = await api().post('/api/v1/auth/login').send({ email: 'sus@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('Tokens: auth guard, refresh rotation, logout', () => {
  // Moves every session's last rotation into the past, past (or inside) the reuse grace window.
  const backdateRotation = (seconds) =>
    drizzle().execute(sql`update sessions set last_used_at = now() - make_interval(secs => ${seconds})`);

  test('protected route needs a valid token', async () => {
    expect((await api().get('/api/v1/users/me')).body.error.code).toBe('TOKEN_MISSING');
    expect((await api().get('/api/v1/users/me').set(bearer('garbage'))).body.error.code).toBe('TOKEN_INVALID');
  });

  test('refresh rotates the token; reusing the old one after the grace window revokes the whole family', async () => {
    const { tokens } = await registerUser();

    const first = await api().post('/api/v1/auth/refresh').send({ refreshToken: tokens.refreshToken });
    expect(first.status).toBe(200);
    const rotated = first.body.data.tokens;
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
    await backdateRotation(61);

    const reuse = await api().post('/api/v1/auth/refresh').send({ refreshToken: tokens.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');

    // The legitimate rotated token is now dead too, and so is its access token.
    const after = await api().post('/api/v1/auth/refresh').send({ refreshToken: rotated.refreshToken });
    expect(after.body.error.code).toBe('REFRESH_TOKEN_INVALID');
    const me = await api().get('/api/v1/users/me').set(bearer(rotated.accessToken));
    expect(me.body.error.code).toBe('SESSION_REVOKED');
  });

  test('a retry with the just-rotated token returns the same current pair and keeps the user signed in', async () => {
    const { tokens } = await registerUser();
    const refresh = (refreshToken) => api().post('/api/v1/auth/refresh').send({ refreshToken });

    const first = await refresh(tokens.refreshToken);
    expect(first.status).toBe(200);
    // The app crashed or reloaded before saving the new token, and presents the old one again.
    const retry = await refresh(tokens.refreshToken);
    expect(retry.status).toBe(200);
    expect(retry.body.data.tokens.refreshToken).toBe(first.body.data.tokens.refreshToken);
    const again = await refresh(tokens.refreshToken);
    expect(again.body.data.tokens.refreshToken).toBe(first.body.data.tokens.refreshToken);

    // Both responses' access tokens work, and the current token rotates normally.
    for (const res of [first, retry]) {
      expect((await api().get('/api/v1/users/me').set(bearer(res.body.data.tokens.accessToken))).status).toBe(200);
    }
    const next = await refresh(first.body.data.tokens.refreshToken);
    expect(next.status).toBe(200);
    expect((await api().get('/api/v1/users/me').set(bearer(next.body.data.tokens.accessToken))).status).toBe(200);
  });

  test('two refreshes racing with the same token both succeed with the same token', async () => {
    const { tokens } = await registerUser();
    const [a, b] = await Promise.all(
      [1, 2].map(() => api().post('/api/v1/auth/refresh').send({ refreshToken: tokens.refreshToken })),
    );
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data.tokens.refreshToken).toBe(b.body.data.tokens.refreshToken);
    const next = await api().post('/api/v1/auth/refresh').send({ refreshToken: a.body.data.tokens.refreshToken });
    expect(next.status).toBe(200);
  });

  test('a token older than the last rotation is still treated as reuse, even inside the grace window', async () => {
    const { tokens } = await registerUser();
    const refresh = (refreshToken) => api().post('/api/v1/auth/refresh').send({ refreshToken });

    const first = await refresh(tokens.refreshToken);
    const second = await refresh(first.body.data.tokens.refreshToken);
    expect(second.status).toBe(200);

    const reuse = await refresh(tokens.refreshToken);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('REFRESH_TOKEN_REUSED');
    const after = await refresh(second.body.data.tokens.refreshToken);
    expect(after.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  test('a retry after logout is refused, not answered with the old pair', async () => {
    const { tokens } = await registerUser();
    const first = await api().post('/api/v1/auth/refresh').send({ refreshToken: tokens.refreshToken });
    await api().post('/api/v1/auth/logout').set(bearer(first.body.data.tokens.accessToken));
    const retry = await api().post('/api/v1/auth/refresh').send({ refreshToken: tokens.refreshToken });
    expect(retry.status).toBe(401);
  });

  test('unknown refresh token -> REFRESH_TOKEN_INVALID', async () => {
    const res = await api().post('/api/v1/auth/refresh').send({ refreshToken: 'x'.repeat(64) });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_TOKEN_INVALID');
  });

  test('logout revokes this device immediately', async () => {
    const { tokens } = await registerUser();
    expect((await api().post('/api/v1/auth/logout').set(bearer(tokens.accessToken))).status).toBe(200);
    const me = await api().get('/api/v1/users/me').set(bearer(tokens.accessToken));
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('SESSION_REVOKED');
    const ref = await api().post('/api/v1/auth/refresh').send({ refreshToken: tokens.refreshToken });
    expect(ref.status).toBe(401);
  });

  test('logout-all signs out every device', async () => {
    const { user, tokens } = await registerUser();
    const second = await api().post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
    await api().post('/api/v1/auth/logout-all').set(bearer(tokens.accessToken));
    const me = await api().get('/api/v1/users/me').set(bearer(second.body.data.tokens.accessToken));
    expect(me.body.error.code).toBe('SESSION_REVOKED');
  });
});

describe('Password reset', () => {
  test('unknown email gets the identical response and no mail', async () => {
    await registerUser({ email: 'known@example.com' });
    outbox.length = 0;
    const known = await api().post('/api/v1/auth/forgot-password').send({ email: 'known@example.com' });
    const unknown = await api().post('/api/v1/auth/forgot-password').send({ email: 'ghost@example.com' });
    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    await new Promise((r) => setImmediate(r));
    expect(outbox.filter((m) => /reset code/i.test(m.subject)).map((m) => m.to)).toEqual(['known@example.com']);
  });

  test('full flow: code -> verify -> reset -> old sessions revoked -> login with new password', async () => {
    const { user, tokens } = await registerUser({ email: 'reset@example.com' });
    await api().post('/api/v1/auth/forgot-password').send({ email: 'reset@example.com' });
    await new Promise((r) => setImmediate(r));
    const code = lastResetCode('reset@example.com');
    expect(code).toMatch(/^\d{6}$/);

    const verify = await api().post('/api/v1/auth/verify-reset-code').send({ email: user.email, code });
    expect(verify.body.data).toEqual({ valid: true });

    const reset = await api()
      .post('/api/v1/auth/reset-password')
      .send({ email: user.email, code, newPassword: 'NewPassword9' });
    expect(reset.status).toBe(200);

    expect((await api().get('/api/v1/users/me').set(bearer(tokens.accessToken))).body.error.code).toBe('SESSION_REVOKED');
    expect((await api().post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD })).status).toBe(401);
    expect((await api().post('/api/v1/auth/login').send({ email: user.email, password: 'NewPassword9' })).status).toBe(200);

    // A code works only once.
    const again = await api()
      .post('/api/v1/auth/reset-password')
      .send({ email: user.email, code, newPassword: 'Another123' });
    expect(again.body.error.code).toBe('RESET_CODE_INVALID');

    await new Promise((r) => setImmediate(r));
    expect(outbox.some((m) => m.to === user.email && /password was changed/i.test(m.subject))).toBe(true);
  });

  test('wrong codes count down, then the code is burned', async () => {
    await registerUser({ email: 'burn@example.com' });
    await api().post('/api/v1/auth/forgot-password').send({ email: 'burn@example.com' });
    await new Promise((r) => setImmediate(r));
    const code = lastResetCode('burn@example.com');
    const wrong = code === '111111' ? '222222' : '111111';

    const remaining = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await api().post('/api/v1/auth/verify-reset-code').send({ email: 'burn@example.com', code: wrong });
      remaining.push(r.body.error.details?.attemptsRemaining);
    }
    expect(remaining).toEqual([4, 3, 2, 1, 0]);

    const right = await api().post('/api/v1/auth/verify-reset-code').send({ email: 'burn@example.com', code });
    expect(right.status).toBe(400);
    expect(right.body.error.code).toBe('RESET_CODE_INVALID');
  });

  test('resend cooldown: a second request within 30s sends no new code', async () => {
    await registerUser({ email: 'cool@example.com' });
    await api().post('/api/v1/auth/forgot-password').send({ email: 'cool@example.com' });
    await api().post('/api/v1/auth/forgot-password').send({ email: 'cool@example.com' });
    await new Promise((r) => setImmediate(r));
    expect(outbox.filter((m) => m.to === 'cool@example.com' && /reset code/i.test(m.subject))).toHaveLength(1);
  });

  test('a newer code invalidates the older one', async () => {
    const { user } = await registerUser({ email: 'newer@example.com' });
    await api().post('/api/v1/auth/forgot-password').send({ email: user.email });
    await new Promise((r) => setImmediate(r));
    const oldCode = lastResetCode(user.email);

    // Skip the cooldown by backdating the first code.
    await db.testing.backdatePasswordResets(60_000);
    await api().post('/api/v1/auth/forgot-password').send({ email: user.email });
    await new Promise((r) => setImmediate(r));
    const newCode = lastResetCode(user.email);
    expect(newCode).toBeTruthy();

    if (oldCode !== newCode) {
      const r = await api().post('/api/v1/auth/verify-reset-code').send({ email: user.email, code: oldCode });
      expect(r.body.error.code).toBe('RESET_CODE_INVALID');
    }
    const ok = await api().post('/api/v1/auth/verify-reset-code').send({ email: user.email, code: newCode });
    expect(ok.status).toBe(200);
  });
});

describe('POST /auth/google', () => {
  const google = require('../src/utils/google');
  const ApiError = require('../src/utils/ApiError');
  const realVerify = google.verifyIdToken;
  // Each fake token maps to the claims Google would return for it.
  const TOKENS = {
    'token-new-user-aaaaaaaaaaaa': { sub: 'g-111', email: 'Meera@Gmail.com', email_verified: true, name: 'Meera Rao' },
    'token-unverified-aaaaaaaaaa': { sub: 'g-222', email: 'x@example.com', email_verified: false },
    'token-asha-aaaaaaaaaaaaaaaa': { sub: 'g-333', email: 'asha@example.com', email_verified: true, name: 'Asha G' },
  };
  beforeAll(() => {
    google.verifyIdToken = async (idToken) => {
      if (!TOKENS[idToken]) throw ApiError.unauthorized('GOOGLE_TOKEN_INVALID', 'Google sign-in failed.');
      return TOKENS[idToken];
    };
  });
  afterAll(() => {
    google.verifyIdToken = realVerify;
  });
  const signIn = (body) => api().post('/api/v1/auth/google').send(body);
  const GOOGLE_PHONE = '+33612345678';

  test('new Google user without a mobile number -> 400 PHONE_REQUIRED, then created with one', async () => {
    const questionnaireSubmissionId = await submitQuestionnaire();
    const res = await signIn({ idToken: 'token-new-user-aaaaaaaaaaaa', questionnaireSubmissionId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PHONE_REQUIRED');
    expect(await db.testing.countUsers()).toBe(0);

    // The submission is still free for the second call.
    const ok = await signIn({ idToken: 'token-new-user-aaaaaaaaaaaa', questionnaireSubmissionId, phone: GOOGLE_PHONE });
    expect(ok.status).toBe(201);
    expect(ok.body.data.user.phone).toBe(GOOGLE_PHONE);
  });

  test('new Google user without a questionnaire -> 404 ACCOUNT_NOT_FOUND', async () => {
    const res = await signIn({ idToken: 'token-new-user-aaaaaaaaaaaa' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_FOUND');
    expect(await db.testing.countUsers()).toBe(0);
  });

  test('new Google user with a questionnaire -> 201, account linked to Google and the submission', async () => {
    const questionnaireSubmissionId = await submitQuestionnaire();
    const res = await signIn({ idToken: 'token-new-user-aaaaaaaaaaaa', questionnaireSubmissionId, phone: GOOGLE_PHONE });
    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe('meera@gmail.com');
    expect(res.body.data.user.name).toBe('Meera Rao');
    expect(res.body.data.user.emailVerified).toBe(true);
    expect(res.body.data.tokens.accessToken).toBeTruthy();

    const stored = await db.users.findByEmail('meera@gmail.com');
    expect(stored.identities).toEqual([expect.objectContaining({ provider: 'google', providerId: 'g-111' })]);
    expect(stored.cohort).toBe('creator');
    const submission = await db.submissions.findById(questionnaireSubmissionId);
    expect(submission.linkedUserId).toBe(stored.id);

    // The random password is never usable for password login.
    const login = await api().post('/api/v1/auth/login').send({ email: 'meera@gmail.com', password: PASSWORD });
    expect(login.status).toBe(401);
  });

  test('returning Google user -> 200 login, no duplicate account', async () => {
    await signIn({ idToken: 'token-new-user-aaaaaaaaaaaa', questionnaireSubmissionId: await submitQuestionnaire(), phone: GOOGLE_PHONE });
    const res = await signIn({ idToken: 'token-new-user-aaaaaaaaaaaa' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('meera@gmail.com');
    expect(await db.testing.countUsers()).toBe(1);
  });

  test('existing email account -> Google is linked, same account, password still works', async () => {
    const { user } = await registerUser({ email: 'asha@example.com' });
    const res = await signIn({ idToken: 'token-asha-aaaaaaaaaaaaaaaa' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.id);
    expect(res.body.data.user.name).toBe(user.name); // not overwritten by Google's name
    expect(await db.testing.countUsers()).toBe(1);

    const stored = await db.users.findById(user.id);
    expect(stored.identities).toHaveLength(1);
    expect(stored.emailVerifiedAt).toBeTruthy();

    const again = await signIn({ idToken: 'token-asha-aaaaaaaaaaaaaaaa' });
    expect(again.status).toBe(200);
    expect((await db.users.findById(user.id)).identities).toHaveLength(1);

    const login = await api().post('/api/v1/auth/login').send({ email: 'asha@example.com', password: PASSWORD });
    expect(login.status).toBe(200);
  });

  test('unverified Google email -> 403 GOOGLE_EMAIL_UNVERIFIED', async () => {
    const res = await signIn({ idToken: 'token-unverified-aaaaaaaaaa', questionnaireSubmissionId: await submitQuestionnaire() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('GOOGLE_EMAIL_UNVERIFIED');
  });

  test('invalid token -> 401 GOOGLE_TOKEN_INVALID', async () => {
    const res = await signIn({ idToken: 'token-forged-aaaaaaaaaaaaaa' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('GOOGLE_TOKEN_INVALID');
  });

  test('an already-used questionnaire submission cannot create a second account', async () => {
    const questionnaireSubmissionId = await submitQuestionnaire();
    await registerUser({ email: 'other@example.com', questionnaireSubmissionId });
    const res = await signIn({ idToken: 'token-new-user-aaaaaaaaaaaa', questionnaireSubmissionId, phone: GOOGLE_PHONE });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('QUESTIONNAIRE_ALREADY_USED');
  });
});
