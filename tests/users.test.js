const db = require('../src/db');
const storage = require('../src/utils/storage');
const { setupDB, resetData, teardownDB, api, registerUser, bearer, outbox, lastChangeCode, PASSWORD } = require('./helpers');

beforeAll(() => setupDB('users'));
beforeEach(resetData);
afterAll(teardownDB);

describe('Profile', () => {
  test('GET /users/me returns user, cohort, settings and legal status', async () => {
    const { tokens } = await registerUser({ name: 'Ravi Kumar' });
    const res = await api().get('/api/v1/users/me').set(bearer(tokens.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe('Ravi Kumar');
    expect(res.body.data.user.cohortDetails).toBeNull(); // cohort is internal only
    expect(JSON.stringify(res.body)).not.toMatch(/"cohort"|readinessTier|segmentTags/);
    expect(res.body.data.settings.notifications.marketing).toBe(false);
    expect(res.body.data.legal.needsReacceptance).toBe(false);
  });

  test('PATCH /users/me updates allowed fields only', async () => {
    const { tokens } = await registerUser();
    const res = await api()
      .patch('/api/v1/users/me')
      .set(bearer(tokens.accessToken))
      .send({ name: 'New Name', bio: 'Painter', country: 'FR', timezone: 'Europe/Paris' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe('New Name');
    expect(res.body.data.user.profile).toMatchObject({ bio: 'Painter', country: 'FR', timezone: 'Europe/Paris' });
  });

  test('PATCH /users/me rejects unknown fields (no role/status escalation) and bad values', async () => {
    const { tokens } = await registerUser();
    const escalate = await api().patch('/api/v1/users/me').set(bearer(tokens.accessToken)).send({ role: 'admin', status: 'member' });
    expect(escalate.status).toBe(400);

    const bad = await api()
      .patch('/api/v1/users/me')
      .set(bearer(tokens.accessToken))
      .send({ timezone: 'Mars/Olympus', country: 'france', avatarUrl: 'http://insecure.example.com/a.png' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d) => d.field).sort()).toEqual(['avatarUrl', 'country', 'timezone']);
  });
});

describe('Changes confirmed by an emailed code', () => {
  const me = (tokens) => api().get('/api/v1/users/me').set(bearer(tokens.accessToken));
  const post = (tokens, path, body) => api().post(`/api/v1/users/me/${path}`).set(bearer(tokens.accessToken)).send(body);

  test('PATCH /users/me no longer changes email or phone directly', async () => {
    const { tokens } = await registerUser();
    const res = await api().patch('/api/v1/users/me').set(bearer(tokens.accessToken)).send({ email: 'x@example.com', phone: '+919876543210' });
    expect(res.status).toBe(400);
  });

  test('phone: code to account email, nothing changes until confirmed, then a notice', async () => {
    const { user, tokens } = await registerUser();

    const req = await post(tokens, 'phone', { phone: '+33 6 12 34 56 78' });
    expect(req.status).toBe(200);
    expect(req.body.data).toMatchObject({ expiresInMinutes: 10, resendAfterSeconds: 30 });
    expect(req.body.data.sentTo).toMatch(/^us\*+@example\.com$/);
    expect((await me(tokens)).body.data.user.phone).toBe(user.phone); // still the number from sign-up

    const code = lastChangeCode(user.email);
    expect(code).toMatch(/^\d{6}$/);
    const wrong = await post(tokens, 'phone/confirm', { code: code === '000000' ? '111111' : '000000' });
    expect(wrong.body.error).toMatchObject({ code: 'CODE_INVALID', details: { attemptsRemaining: 4 } });

    const ok = await post(tokens, 'phone/confirm', { code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.phone).toBe('+33612345678');
    expect(outbox.some((m) => m.to === user.email && /phone number was changed/i.test(m.subject))).toBe(true);

    // A used code cannot be replayed; removing the phone right after is allowed (no cooldown after a confirmed change).
    expect((await post(tokens, 'phone/confirm', { code })).body.error.code).toBe('CODE_INVALID');
    expect((await post(tokens, 'phone', { phone: null })).status).toBe(200);
    const removed = await post(tokens, 'phone/confirm', { code: lastChangeCode(user.email) });
    expect(removed.body.data.user.phone).toBeNull();
  });

  test('phone: validation, unchanged and taken', async () => {
    const a = await registerUser();
    const b = await registerUser();
    await post(a.tokens, 'phone', { phone: '+919876543210' });
    await post(a.tokens, 'phone/confirm', { code: lastChangeCode(a.user.email) });

    expect((await post(b.tokens, 'phone', { phone: '98765' })).body.error.details.map((d) => d.field)).toEqual(['phone']);
    expect((await post(a.tokens, 'phone', { phone: '+919876543210' })).body.error.code).toBe('PHONE_UNCHANGED');
    const taken = await post(b.tokens, 'phone', { phone: '+91 98765-43210' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('PHONE_TAKEN');
  });

  test('email: needs the current password, code goes to the NEW address, old address notified', async () => {
    const { tokens } = await registerUser({ email: 'old@example.com' });

    const wrong = await post(tokens, 'email', { email: 'new@example.com', currentPassword: 'Wrong1234' });
    expect(wrong.body.error.code).toBe('PASSWORD_INCORRECT');
    expect((await post(tokens, 'email', { email: 'old@example.com', currentPassword: PASSWORD })).body.error.code).toBe('EMAIL_UNCHANGED');

    const req = await post(tokens, 'email', { email: ' New@Example.com ', currentPassword: PASSWORD });
    expect(req.status).toBe(200);
    expect(lastChangeCode('old@example.com')).toBeUndefined();
    const code = lastChangeCode('new@example.com');
    expect(code).toMatch(/^\d{6}$/);

    // Still the old email until confirmed
    expect((await api().post('/api/v1/auth/login').send({ email: 'old@example.com', password: PASSWORD })).status).toBe(200);

    const ok = await post(tokens, 'email/confirm', { code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user).toMatchObject({ email: 'new@example.com', emailVerified: true });
    expect(outbox.some((m) => m.to === 'old@example.com' && /email was changed/i.test(m.subject))).toBe(true);
    expect((await api().post('/api/v1/auth/login').send({ email: 'new@example.com', password: PASSWORD })).status).toBe(200);
    expect((await api().post('/api/v1/auth/login').send({ email: 'old@example.com', password: PASSWORD })).status).toBe(401);
  });

  test("email: cannot request another account's email, or confirm if it was taken meanwhile", async () => {
    const a = await registerUser({ email: 'a@example.com' });
    const b = await registerUser();
    const taken = await post(b.tokens, 'email', { email: 'a@example.com', currentPassword: PASSWORD });
    expect(taken.body.error.code).toBe('EMAIL_TAKEN');

    await post(b.tokens, 'email', { email: 'race@example.com', currentPassword: PASSWORD });
    await post(a.tokens, 'email', { email: 'race@example.com', currentPassword: PASSWORD });
    const [codeB, codeA] = outbox.filter((m) => m.to === 'race@example.com').map((m) => m.text.match(/\b(\d{6})\b/)[1]);
    expect((await post(a.tokens, 'email/confirm', { code: codeA })).status).toBe(200);
    expect((await post(b.tokens, 'email/confirm', { code: codeB })).body.error.code).toBe('EMAIL_TAKEN');
  });

  test('a code only confirms its own kind of change, and resending is rate-limited', async () => {
    const { user, tokens } = await registerUser();
    await post(tokens, 'phone', { phone: '+919876543210' });
    const code = lastChangeCode(user.email);
    expect((await post(tokens, 'email/confirm', { code })).body.error.code).toBe('CODE_INVALID');

    const again = await post(tokens, 'phone', { phone: '+919876543211' });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('CODE_RECENTLY_SENT');
    expect(again.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('a pending change is cancelled once the password changes', async () => {
    const { user, tokens } = await registerUser();
    await post(tokens, 'phone', { phone: '+919876543210' });
    const phoneCode = lastChangeCode(user.email);

    await api().patch('/api/v1/users/me/password').set(bearer(tokens.accessToken)).send({ currentPassword: PASSWORD, newPassword: 'Changed123' });
    await new Promise((r) => setTimeout(r, 5)); // passwordChangedAt strictly after the phone request
    expect((await post(tokens, 'password/confirm', { code: lastChangeCode(user.email) })).status).toBe(200);

    expect((await post(tokens, 'phone/confirm', { code: phoneCode })).body.error.code).toBe('CODE_INVALID');
  });
});

describe('Profile photo', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
  const storedIds = () => [...storage.uploads.keys()];

  test('upload, replace (previous upload deleted) and remove', async () => {
    const { user, tokens } = await registerUser();

    const first = await api().put('/api/v1/users/me/avatar').set(bearer(tokens.accessToken)).attach('avatar', PNG, 'me.png');
    expect(first.status).toBe(200);
    expect(first.body.data.user.profile.avatarUrl).toMatch(/^https:\/\/res\.cloudinary\.com\/.+\/papolona\/avatars\//);
    expect(first.body.data.user.profile).not.toHaveProperty('avatarPublicId');
    const firstId = (await db.users.findById(user.id)).profile.avatarPublicId;
    expect(storedIds()).toContain(firstId);

    const second = await api().put('/api/v1/users/me/avatar').set(bearer(tokens.accessToken)).attach('avatar', JPG, 'me.jpg');
    expect(second.status).toBe(200);
    const secondId = (await db.users.findById(user.id)).profile.avatarPublicId;
    expect(secondId).not.toBe(firstId);
    expect(storedIds()).not.toContain(firstId);
    expect(storedIds()).toContain(secondId);

    const removed = await api().delete('/api/v1/users/me/avatar').set(bearer(tokens.accessToken));
    expect(removed.body.data.user.profile.avatarUrl).toBeNull();
    expect(storedIds()).not.toContain(secondId);
  });

  test('setting an external avatarUrl or deleting the account removes the uploaded photo', async () => {
    const { user, tokens } = await registerUser();
    const getId = async () => (await db.users.findById(user.id)).profile.avatarPublicId;

    await api().put('/api/v1/users/me/avatar').set(bearer(tokens.accessToken)).attach('avatar', PNG, 'me.png');
    const firstId = await getId();
    await api().patch('/api/v1/users/me').set(bearer(tokens.accessToken)).send({ avatarUrl: 'https://example.com/me.png' });
    expect(storedIds()).not.toContain(firstId);
    expect(await getId()).toBeNull();

    await api().put('/api/v1/users/me/avatar').set(bearer(tokens.accessToken)).attach('avatar', PNG, 'me.png');
    const secondId = await getId();
    await api().delete('/api/v1/users/me').set(bearer(tokens.accessToken)).send({ password: PASSWORD });
    expect(storedIds()).not.toContain(secondId);
  });

  test('rejects missing file, non-images (whatever the name says) and files over the limit', async () => {
    const { tokens } = await registerUser();
    const put = () => api().put('/api/v1/users/me/avatar').set(bearer(tokens.accessToken));

    expect((await put().field('x', '1')).status).toBe(400);
    expect((await put().attach('avatar', Buffer.from('<?php echo 1; ?>'), 'evil.png')).body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect((await put().attach('photo', PNG, 'me.png')).body.error.code).toBe('INVALID_UPLOAD');

    const big = await put().attach('avatar', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]), 'big.png');
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
  });

  test('requires authentication', async () => {
    expect((await api().put('/api/v1/users/me/avatar').attach('avatar', PNG, 'me.png')).status).toBe(401);
  });
});

describe('Settings', () => {
  test('partial update of notifications, reminder time and language', async () => {
    const { tokens } = await registerUser();
    const res = await api()
      .patch('/api/v1/users/me/settings')
      .set(bearer(tokens.accessToken))
      .send({ notifications: { readingReminders: false, marketing: true }, reminderTime: '20:30' });
    expect(res.status).toBe(200);
    expect(res.body.data.settings.notifications).toEqual({
      readingReminders: false,
      sequenceDeadline: true,
      productUpdates: true,
      marketing: true,
    });
    expect(res.body.data.settings.reminderTime).toBe('20:30');

    const get = await api().get('/api/v1/users/me/settings').set(bearer(tokens.accessToken));
    expect(get.body.data.settings.reminderTime).toBe('20:30');
  });

  test('rejects invalid reminder time and empty body', async () => {
    const { tokens } = await registerUser();
    expect((await api().patch('/api/v1/users/me/settings').set(bearer(tokens.accessToken)).send({ reminderTime: '25:00' })).status).toBe(400);
    expect((await api().patch('/api/v1/users/me/settings').set(bearer(tokens.accessToken)).send({})).status).toBe(400);
  });
});

describe('Change password & devices', () => {
  test('nothing changes until the emailed code is confirmed; then keeps this device, signs out the others', async () => {
    const { user, tokens } = await registerUser();
    const other = (await api().post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD })).body.data.tokens;

    const res = await api()
      .patch('/api/v1/users/me/password')
      .set(bearer(tokens.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: 'Changed123' });
    expect(res.status).toBe(200);
    expect((await api().post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD })).status).toBe(200);
    expect((await api().get('/api/v1/users/me').set(bearer(other.accessToken))).status).toBe(200);

    const stored = await db.testing.latestPendingChange(user.id, 'password');
    expect(stored.value).not.toContain('Changed123'); // only the bcrypt hash is kept

    const confirm = await api()
      .post('/api/v1/users/me/password/confirm')
      .set(bearer(tokens.accessToken))
      .send({ code: lastChangeCode(user.email) });
    expect(confirm.status).toBe(200);
    expect(outbox.some((m) => m.to === user.email && /password was changed/i.test(m.subject))).toBe(true);

    expect((await api().get('/api/v1/users/me').set(bearer(tokens.accessToken))).status).toBe(200);
    expect((await api().get('/api/v1/users/me').set(bearer(other.accessToken))).body.error.code).toBe('SESSION_REVOKED');
    expect((await api().post('/api/v1/auth/login').send({ email: user.email, password: 'Changed123' })).status).toBe(200);
  });

  test('wrong current password and unchanged password are rejected', async () => {
    const { tokens } = await registerUser();
    const wrong = await api()
      .patch('/api/v1/users/me/password')
      .set(bearer(tokens.accessToken))
      .send({ currentPassword: 'Nope12345', newPassword: 'Changed123' });
    expect(wrong.body.error.code).toBe('PASSWORD_INCORRECT');
    const same = await api()
      .patch('/api/v1/users/me/password')
      .set(bearer(tokens.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.body.error.code).toBe('PASSWORD_UNCHANGED');
  });

  test('list devices and sign out another device', async () => {
    const { user, tokens } = await registerUser();
    const other = (
      await api().post('/api/v1/auth/login').set('x-platform', 'android').send({ email: user.email, password: PASSWORD })
    ).body.data.tokens;

    const list = await api().get('/api/v1/users/me/sessions').set(bearer(tokens.accessToken));
    expect(list.body.data.sessions).toHaveLength(2);
    const target = list.body.data.sessions.find((s) => !s.current);
    expect(target.platform).toBe('android');

    expect((await api().delete(`/api/v1/users/me/sessions/${target.id}`).set(bearer(tokens.accessToken))).status).toBe(200);
    expect((await api().get('/api/v1/users/me').set(bearer(other.accessToken))).status).toBe(401);
  });

  test("cannot revoke another user's session", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const bSessions = await api().get('/api/v1/users/me/sessions').set(bearer(b.tokens.accessToken));
    const res = await api()
      .delete(`/api/v1/users/me/sessions/${bSessions.body.data.sessions[0].id}`)
      .set(bearer(a.tokens.accessToken));
    expect(res.status).toBe(404);
  });
});

describe('Legal re-acceptance', () => {
  afterEach(async () => {
    // Restore Terms 1.0 as current so other tests are unaffected.
    await db.appConfig.setLegalVersions({ termsVersion: '1.0' });
  });

  test('new Terms version -> needsReacceptance -> accept -> cleared', async () => {
    const { tokens } = await registerUser();
    await db.appConfig.setLegalVersions({ termsVersion: '1.1' });

    const me = await api().get('/api/v1/users/me').set(bearer(tokens.accessToken));
    expect(me.body.data.legal.needsReacceptance).toBe(true);
    expect(me.body.data.legal.current.termsVersion).toBe('1.1');

    const stale = await api()
      .post('/api/v1/users/me/legal/accept')
      .set(bearer(tokens.accessToken))
      .send({ termsVersion: '1.0', privacyVersion: '1.0' });
    expect(stale.body.error.code).toBe('LEGAL_VERSION_OUTDATED');

    const ok = await api()
      .post('/api/v1/users/me/legal/accept')
      .set(bearer(tokens.accessToken))
      .send({ termsVersion: '1.1', privacyVersion: '1.0' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.legal.needsReacceptance).toBe(false);
  });
});

describe('Delete account', () => {
  test('requires password, anonymises data, revokes sessions, frees the email', async () => {
    const { user, tokens } = await registerUser({ email: 'leave@example.com' });

    const wrong = await api().delete('/api/v1/users/me').set(bearer(tokens.accessToken)).send({ password: 'Wrong1234' });
    expect(wrong.body.error.code).toBe('PASSWORD_INCORRECT');

    const res = await api().delete('/api/v1/users/me').set(bearer(tokens.accessToken)).send({ password: PASSWORD });
    expect(res.status).toBe(200);

    const stored = await db.users.findById(user.id);
    expect(stored.status).toBe('deleted');
    expect(stored.name).toBe('Deleted user');
    expect(stored.email).not.toContain('leave@example.com');
    expect(stored.cohort).toBe('creator'); // pseudonymous research field kept

    expect((await api().get('/api/v1/users/me').set(bearer(tokens.accessToken))).status).toBe(401);
    expect((await api().post('/api/v1/auth/login').send({ email: 'leave@example.com', password: PASSWORD })).status).toBe(401);

    // Same email can register again
    await expect(registerUser({ email: 'leave@example.com' })).resolves.toBeTruthy();
  });
});
