const { sql } = require('drizzle-orm');
const db = require('../src/db');
const { db: drizzle } = require('../src/db/postgres/connection');
const { streaks } = require('../src/modules/stats/stats.service');
const { setupDB, resetData, teardownDB, api, registerUser, bearer } = require('./helpers');

beforeAll(() => setupDB('stats'));
beforeEach(resetData);
afterAll(teardownDB);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const getStats = (token, query) => api().get('/api/v1/stats').query(query).set(bearer(token));

/** A reading at `at`, optionally judged and rated, written straight to the database. */
async function addReading(userId, at, { verdict, user, ai } = {}) {
  const draw = await db.clueDraws.create({
    userId,
    clue: 'ABCDEF',
    question: 'Q?',
    generatedAt: at,
    nextAvailableAt: new Date(at.getTime() + DAY),
  });
  if (verdict) {
    await db.clueDraws.saveJudgement(userId, draw.id, {
      attempt: 1,
      text: 'AB-CDEF interpretation',
      source: 'text',
      verdict,
      parts: [],
      feedback: 'F',
      eeriness: ai?.[0],
      satisfaction: ai?.[1],
      model: 'test',
      judgedAt: at,
    });
  }
  if (user) await db.clueDraws.saveUserRating(userId, draw.id, { eeriness: user[0], satisfaction: user[1], ratedAt: at });
  return draw;
}

async function addNote(userId, at) {
  await db.journal.create({ userId, text: 'note', source: 'text', clientId: `c-${Math.random()}` });
  // Backdate the newest note to `at`.
  await drizzle().execute(
    sql`update journal_entries set created_at = ${at.toISOString()}::timestamptz
        where id = (select id from journal_entries where user_id = ${userId} order by id desc limit 1)`,
  );
}

async function signedIn() {
  const { tokens, user } = await registerUser();
  return { token: tokens.accessToken, userId: user.id };
}

describe('GET /stats', () => {
  test('requires a signed-in user and a valid query', async () => {
    expect((await api().get('/api/v1/stats').query({ unit: 'day' })).status).toBe(401);
    const { token } = await signedIn();
    expect((await getStats(token, { unit: 'week' })).status).toBe(400);
    expect((await getStats(token, { unit: 'day', from: '2026-13-01' })).status).toBe(400);
    expect((await getStats(token, { unit: 'day', tzOffset: 9999 })).status).toBe(400);
    expect((await getStats(token, { unit: 'day', from: '2026-02-02', to: '2026-02-01' })).status).toBe(400);
    expect((await getStats(token, { unit: 'day', from: '2020-01-01', to: '2026-01-01' })).status).toBe(400);
  });

  test('day buckets: readings, pass/fail, notes and average ratings, with empty days filled', async () => {
    const { token, userId } = await signedIn();
    await addReading(userId, new Date('2026-03-02T09:00:00Z'), { verdict: 'pass', user: [8, 6], ai: [6, 7] });
    await addReading(userId, new Date('2026-03-02T20:00:00Z'), { verdict: 'fail', user: [4, 2], ai: [2, 3] });
    await addReading(userId, new Date('2026-03-04T09:00:00Z'));
    await addNote(userId, new Date('2026-03-02T10:00:00Z'));
    await addNote(userId, new Date('2026-03-03T10:00:00Z'));
    await addNote(userId, new Date('2026-03-03T11:00:00Z'));

    const res = await getStats(token, { unit: 'day', from: '2026-03-01', to: '2026-03-04' });
    expect(res.status).toBe(200);
    const { series, totals } = res.body.data;
    expect(series.map((b) => b.start)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04']);
    expect(series[0]).toMatchObject({ readings: 0, notes: 0, userEeriness: null });
    expect(series[1]).toMatchObject({
      readings: 2,
      passed: 1,
      failed: 1,
      notes: 1,
      userEeriness: 6,
      userSatisfaction: 4,
      aiEeriness: 4,
      aiSatisfaction: 5,
    });
    expect(series[2]).toMatchObject({ readings: 0, notes: 2 });
    expect(series[3]).toMatchObject({ readings: 1, passed: 0, failed: 0 });
    expect(totals).toMatchObject({ readings: 3, passed: 1, failed: 1, notes: 3, userEeriness: 6, aiSatisfaction: 5 });
  });

  test('days are cut at the user’s local midnight', async () => {
    const { token, userId } = await signedIn();
    // 20:00 UTC on 2 March is 01:30 on 3 March in India (UTC+05:30).
    await addReading(userId, new Date('2026-03-02T20:00:00Z'));

    const utc = (await getStats(token, { unit: 'day', from: '2026-03-02', to: '2026-03-03' })).body.data.series;
    expect(utc.map((b) => b.readings)).toEqual([1, 0]);
    const india = (await getStats(token, { unit: 'day', from: '2026-03-02', to: '2026-03-03', tzOffset: 330 })).body.data
      .series;
    expect(india.map((b) => b.readings)).toEqual([0, 1]);
  });

  test('month and year buckets; without `from` the range starts at the first activity', async () => {
    const { token, userId } = await signedIn();
    await addReading(userId, new Date('2025-11-15T09:00:00Z'), { verdict: 'pass' });
    await addReading(userId, new Date('2026-01-10T09:00:00Z'));
    await addNote(userId, new Date('2026-01-11T09:00:00Z'));

    const months = (await getStats(token, { unit: 'month', to: '2026-02-20' })).body.data;
    expect(months.firstActivity).toBe('2025-11-15');
    expect(months.series.map((b) => [b.start, b.readings, b.notes])).toEqual([
      ['2025-11-01', 1, 0],
      ['2025-12-01', 0, 0],
      ['2026-01-01', 1, 1],
      ['2026-02-01', 0, 0],
    ]);

    const years = (await getStats(token, { unit: 'year', to: '2026-02-20' })).body.data.series;
    expect(years.map((b) => [b.start, b.readings, b.passed])).toEqual([
      ['2025-01-01', 1, 1],
      ['2026-01-01', 1, 0],
    ]);
  });

  test('a new user gets one empty bucket for today and no streak', async () => {
    const { token } = await signedIn();
    const data = (await getStats(token, { unit: 'day' })).body.data;
    expect(data.firstActivity).toBeNull();
    expect(data.series).toHaveLength(1);
    expect(data.series[0].start).toBe(data.today);
    expect(data.streak).toEqual({ current: 0, best: 0 });
  });

  test('only counts the user’s own activity', async () => {
    const me = await signedIn();
    const other = await signedIn();
    await addReading(other.userId, new Date('2026-03-02T09:00:00Z'));
    const series = (await getStats(me.token, { unit: 'day', from: '2026-03-02', to: '2026-03-02' })).body.data.series;
    expect(series[0].readings).toBe(0);
  });
});

describe('streaks', () => {
  test('current run lasts while the last reading was today or yesterday; best is the longest run', () => {
    const days = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-07', '2026-03-08'];
    expect(streaks(days, '2026-03-08')).toEqual({ current: 2, best: 3 });
    expect(streaks(days, '2026-03-09')).toEqual({ current: 2, best: 3 });
    expect(streaks(days, '2026-03-10')).toEqual({ current: 0, best: 3 });
    expect(streaks([], '2026-03-10')).toEqual({ current: 0, best: 0 });
  });

  test('crosses month ends', () => {
    expect(streaks(['2026-02-27', '2026-02-28', '2026-03-01'], '2026-03-01')).toEqual({ current: 3, best: 3 });
  });
});
