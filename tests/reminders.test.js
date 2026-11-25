const env = require('../src/config/env');
const db = require('../src/db');
const { outbox } = require('../src/utils/mailer');
const { dispatchDue } = require('../src/modules/reminders/reminders.service');
const { nextOccurrence, zonedToUtc, localDateTime } = require('../src/utils/zonedTime');
const { setupDB, resetData, teardownDB, api, registerUser, bearer } = require('./helpers');

beforeAll(() => setupDB('reminders'));
beforeEach(resetData);
afterAll(teardownDB);

const HOUR = 60 * 60 * 1000;
const inHours = (h) => new Date(Date.now() + h * HOUR).toISOString();

async function signedIn() {
  const { tokens, user } = await registerUser();
  outbox.length = 0; // drop the welcome email: these tests count reminder emails only
  return { token: tokens.accessToken, userId: user.id, email: user.email };
}

const create = (token, body) => api().post('/api/v1/reminders').set(bearer(token)).send(body);
const list = (token) => api().get('/api/v1/reminders').set(bearer(token));
const patch = (token, id, body) => api().patch(`/api/v1/reminders/${id}`).set(bearer(token)).send(body);

const REMINDER = { title: 'Call the gallery', note: 'Ask about the prism print.', repeat: 'none', timeZone: 'Asia/Kolkata' };

describe('reminders API', () => {
  test('requires a signed-in user', async () => {
    expect((await api().get('/api/v1/reminders')).status).toBe(401);
  });

  test('create, list, edit, pause and delete', async () => {
    const { token } = await signedIn();
    const created = await create(token, { ...REMINDER, remindAt: inHours(2) });
    expect(created.status).toBe(201);
    const { reminder } = created.body.data;
    expect(reminder).toMatchObject({ title: 'Call the gallery', note: 'Ask about the prism print.', repeat: 'none', active: true });

    await create(token, { ...REMINDER, title: 'Sooner', remindAt: inHours(1) });
    expect((await list(token)).body.data.reminders.map((r) => r.title)).toEqual(['Sooner', 'Call the gallery']);

    const edited = await patch(token, reminder.id, { title: 'Call the museum', repeat: 'weekly' });
    expect(edited.body.data.reminder).toMatchObject({ title: 'Call the museum', repeat: 'weekly' });

    const paused = await patch(token, reminder.id, { active: false });
    expect(paused.body.data.reminder.active).toBe(false);
    expect((await list(token)).body.data.reminders.map((r) => r.title)).toEqual(['Sooner', 'Call the museum']);

    expect((await api().delete(`/api/v1/reminders/${reminder.id}`).set(bearer(token))).status).toBe(200);
    expect((await list(token)).body.data.reminders).toHaveLength(1);
  });

  test('validates title, time, repeat and time zone', async () => {
    const { token } = await signedIn();
    expect((await create(token, { ...REMINDER, title: ' ', remindAt: inHours(1) })).status).toBe(400);
    expect((await create(token, { ...REMINDER, remindAt: 'tomorrow' })).status).toBe(400);
    expect((await create(token, { ...REMINDER, repeat: 'hourly', remindAt: inHours(1) })).status).toBe(400);
    expect((await create(token, { ...REMINDER, timeZone: 'Mars/Olympus', remindAt: inHours(1) })).status).toBe(400);
    const past = await create(token, { ...REMINDER, remindAt: inHours(-1) });
    expect(past.status).toBe(400);
    expect(past.body.error.code).toBe('REMINDER_IN_PAST');
  });

  test('only the owner can see, edit or delete a reminder', async () => {
    const owner = await signedIn();
    const other = await signedIn();
    const { reminder } = (await create(owner.token, { ...REMINDER, remindAt: inHours(1) })).body.data;
    expect((await list(other.token)).body.data.reminders).toEqual([]);
    expect((await patch(other.token, reminder.id, { title: 'Mine' })).status).toBe(404);
    expect((await api().delete(`/api/v1/reminders/${reminder.id}`).set(bearer(other.token))).status).toBe(404);
  });
});

describe('dispatching reminder emails', () => {
  test('a due one-off reminder is emailed once, then switched off', async () => {
    const { token, email } = await signedIn();
    const { reminder } = (await create(token, { ...REMINDER, remindAt: inHours(1) })).body.data;

    await dispatchDue(new Date(Date.now() + 30 * 60 * 1000));
    expect(outbox).toHaveLength(0);

    await dispatchDue(new Date(Date.now() + 61 * 60 * 1000));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: email, subject: 'Reminder: Call the gallery' });
    expect(outbox[0].text).toContain('Ask about the prism print.');

    await dispatchDue(new Date(Date.now() + 2 * HOUR));
    expect(outbox).toHaveLength(1);
    const saved = (await list(token)).body.data.reminders.find((r) => r.id === reminder.id);
    expect(saved).toMatchObject({ active: false });
    expect(saved.lastSentAt).toBeTruthy();
  });

  test('a repeating reminder moves to its next time and keeps going', async () => {
    const { token } = await signedIn();
    // Reminders are set to the minute, as the app's picker does.
    const first = new Date(Math.ceil((Date.now() + HOUR) / 60000) * 60000);
    const { reminder } = (await create(token, { ...REMINDER, repeat: 'daily', remindAt: first.toISOString() })).body.data;

    await dispatchDue(new Date(first.getTime() + 60 * 1000));
    expect(outbox).toHaveLength(1);
    let saved = (await list(token)).body.data.reminders[0];
    expect(saved.active).toBe(true);
    expect(new Date(saved.remindAt).getTime()).toBe(first.getTime() + 24 * HOUR);

    // Missed days (e.g. the server was down) send one email and skip ahead to the next future time.
    await dispatchDue(new Date(first.getTime() + 3.5 * 24 * HOUR));
    expect(outbox).toHaveLength(2);
    saved = (await list(token)).body.data.reminders.find((r) => r.id === reminder.id);
    expect(new Date(saved.remindAt).getTime()).toBe(first.getTime() + 4 * 24 * HOUR);
  });

  test('overlapping runs never send the same reminder twice', async () => {
    const { token } = await signedIn();
    await create(token, { ...REMINDER, remindAt: inHours(1) });
    const later = new Date(Date.now() + 2 * HOUR);
    await Promise.all([dispatchDue(later), dispatchDue(later), dispatchDue(later)]);
    expect(outbox).toHaveLength(1);
  });

  test('resuming a paused repeat moves it to the next future time; a past one-off needs a new time', async () => {
    const { token, userId } = await signedIn();
    const daily = (await create(token, { ...REMINDER, repeat: 'daily', remindAt: inHours(1) })).body.data.reminder;
    const once = (await create(token, { ...REMINDER, remindAt: inHours(1) })).body.data.reminder;
    // Both fell due while paused.
    const past = new Date(Date.now() - 5 * HOUR);
    await db.reminders.update(userId, daily.id, { active: false, remindAt: past, startsAt: past });
    await db.reminders.update(userId, once.id, { active: false, remindAt: past, startsAt: past });

    const resumed = await patch(token, daily.id, { active: true });
    expect(resumed.status).toBe(200);
    expect(new Date(resumed.body.data.reminder.remindAt).getTime()).toBeGreaterThan(Date.now());
    expect((await patch(token, once.id, { active: true })).body.error.code).toBe('REMINDER_IN_PAST');
    expect((await patch(token, once.id, { active: true, remindAt: inHours(3) })).status).toBe(200);
  });
});

describe('daily reading reminder', () => {
  // 03:30 UTC is 09:00 in India.
  const indiaNine = (day) => new Date(`${day}T03:30:00Z`);

  async function readingUser(time = '09:00') {
    const user = await signedIn();
    await api().patch('/api/v1/users/me').set(bearer(user.token)).send({ timezone: 'Asia/Kolkata' });
    await api().patch('/api/v1/users/me/settings').set(bearer(user.token)).send({ reminderTime: time });
    return user;
  }

  test('sent once a day at or after the reminder time in the user’s zone', async () => {
    const { email } = await readingUser('09:00');
    await dispatchDue(new Date(indiaNine('2026-03-02').getTime() - 60 * 1000)); // 08:59
    expect(outbox).toHaveLength(0);
    await dispatchDue(indiaNine('2026-03-02'));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: email, subject: 'Your Papolona reading is waiting' });
    await dispatchDue(new Date(indiaNine('2026-03-02').getTime() + 5 * HOUR));
    expect(outbox).toHaveLength(1);
    await dispatchDue(indiaNine('2026-03-03'));
    expect(outbox).toHaveLength(2);
  });

  test('not sent when today’s clue was already drawn, when switched off, or without a time zone', async () => {
    const drawn = await readingUser();
    await db.clueDraws.create({
      userId: drawn.userId,
      clue: 'ABCDEF',
      question: 'Q?',
      generatedAt: new Date('2026-03-02T01:00:00Z'), // 06:30 in India, the same local day
      nextAvailableAt: new Date('2026-03-03T01:00:00Z'),
    });
    const off = await readingUser();
    await api()
      .patch('/api/v1/users/me/settings')
      .set(bearer(off.token))
      .send({ notifications: { readingReminders: false } });
    await signedIn(); // no time zone set

    await dispatchDue(indiaNine('2026-03-02'));
    expect(outbox).toHaveLength(0);
  });
});

describe('last hour of a reading', () => {
  const { qrng } = require('../src/modules/clue/clue.service');
  const realFetch = qrng.fetchHexStrings;
  beforeEach(() => {
    env.QRNG_API_KEY = 'test-key';
    qrng.fetchHexStrings = async () => ['48656c6c6f2021', '576f726c64']; // HELLOW
  });
  afterEach(() => {
    qrng.fetchHexStrings = realFetch;
    env.QRNG_API_KEY = undefined;
  });
  const draw = (token) => api().post('/api/v1/clue-string').set(bearer(token)).send({ question: 'Q?' });

  test('emails once as the last hour starts, only for the latest reading still open, and not with deadline emails off', async () => {
    const { token, userId, email } = await signedIn();
    await draw(token);
    await dispatchDue();
    expect(outbox).toHaveLength(0); // 12 hours left

    await db.testing.backdateDraws(userId, 11.5 * HOUR);
    await dispatchDue();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: email, subject: 'Less than an hour left for your reading HELLOW' });
    await dispatchDue();
    expect(outbox).toHaveLength(1);

    // Time is up: no email for a reading that has already failed.
    const late = await signedIn();
    await draw(late.token);
    await db.testing.backdateDraws(late.userId, 12.5 * HOUR);
    await dispatchDue();
    expect(outbox).toHaveLength(0); // signedIn() empties the outbox

    const off = await signedIn();
    await api()
      .patch('/api/v1/users/me/settings')
      .set(bearer(off.token))
      .send({ notifications: { sequenceDeadline: false } });
    await draw(off.token);
    await db.testing.backdateDraws(off.userId, 11.5 * HOUR);
    await dispatchDue();
    expect(outbox).toHaveLength(0);
  });
});

describe('GET /internal/cron/reminders', () => {
  const realSecret = env.CRON_SECRET;
  afterEach(() => {
    env.CRON_SECRET = realSecret;
  });

  test('off without CRON_SECRET; needs the secret; runs the dispatcher', async () => {
    env.CRON_SECRET = undefined;
    expect((await api().get('/api/v1/internal/cron/reminders')).status).toBe(503);

    env.CRON_SECRET = 'test-cron-secret-123456';
    expect((await api().get('/api/v1/internal/cron/reminders')).status).toBe(401);
    expect(
      (await api().get('/api/v1/internal/cron/reminders').set('Authorization', 'Bearer wrong-secret-0000000')).status,
    ).toBe(401);

    const { token, userId } = await signedIn();
    const { reminder } = (await create(token, { ...REMINDER, remindAt: inHours(1) })).body.data;
    // Make it due now.
    const past = new Date(Date.now() - 60 * 1000);
    await db.reminders.update(userId, reminder.id, { remindAt: past, startsAt: past });

    const res = await api().get('/api/v1/internal/cron/reminders').set('Authorization', 'Bearer test-cron-secret-123456');
    expect(res.status).toBe(200);
    expect(res.body.data.reminders).toEqual({ sent: 1, failed: 0 });
    expect(outbox).toHaveLength(1);
  });
});

describe('zoned time', () => {
  test('converts local wall time to UTC across daylight saving', () => {
    // London: GMT in January, BST (UTC+1) in July.
    expect(zonedToUtc({ year: 2026, month: 1, day: 10, hour: 9, minute: 0 }, 'Europe/London').toISOString()).toBe(
      '2026-01-10T09:00:00.000Z',
    );
    expect(zonedToUtc({ year: 2026, month: 7, day: 10, hour: 9, minute: 0 }, 'Europe/London').toISOString()).toBe(
      '2026-07-10T08:00:00.000Z',
    );
    expect(localDateTime(new Date('2026-03-02T20:00:00Z'), 'Asia/Kolkata')).toEqual({ date: '2026-03-03', time: '01:30' });
  });

  test('daily repeats keep the local time over a clock change', () => {
    // 09:00 London on 28 March 2026 (GMT); British Summer Time starts 29 March.
    const start = new Date('2026-03-28T09:00:00Z');
    const next = nextOccurrence(start, 'daily', 'Europe/London', new Date('2026-03-28T10:00:00Z'));
    expect(next.toISOString()).toBe('2026-03-29T08:00:00.000Z');
  });

  test('monthly repeats use the last day of short months without drifting', () => {
    const start = zonedToUtc({ year: 2026, month: 1, day: 31, hour: 9, minute: 0 }, 'Asia/Kolkata');
    const feb = nextOccurrence(start, 'monthly', 'Asia/Kolkata', new Date('2026-02-01T00:00:00Z'));
    expect(localDateTime(feb, 'Asia/Kolkata')).toEqual({ date: '2026-02-28', time: '09:00' });
    const mar = nextOccurrence(start, 'monthly', 'Asia/Kolkata', new Date('2026-03-01T00:00:00Z'));
    expect(localDateTime(mar, 'Asia/Kolkata')).toEqual({ date: '2026-03-31', time: '09:00' });
  });

  test('weekly repeats and one-offs', () => {
    const start = new Date('2026-03-02T09:00:00Z');
    expect(nextOccurrence(start, 'weekly', 'UTC', new Date('2026-03-20T00:00:00Z')).toISOString()).toBe(
      '2026-03-23T09:00:00.000Z',
    );
    expect(nextOccurrence(start, 'none', 'UTC', new Date())).toBeNull();
  });
});
