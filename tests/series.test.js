const env = require('../src/config/env');
const db = require('../src/db');
const { qrng } = require('../src/modules/clue/clue.service');
const judgeAi = require('../src/modules/clue/judge.ai');
const { shuffledTiles } = require('../src/modules/series/series.service');
const { setupDB, resetData, teardownDB, api, registerUser, bearer } = require('./helpers');

beforeAll(() => setupDB('series'));
beforeEach(resetData);
afterAll(teardownDB);

// The clue is HELLOW; the judge passes or fails as each test sets it.
const SAMPLE = ['48656c6c6f2021', '576f726c64'];
const realFetch = qrng.fetchHexStrings;
const realChat = judgeAi.llm.chat;
const saved = { qrng: env.QRNG_API_KEY, ai: env.ANTHROPIC_API_KEY };
const reply = (verdict) => JSON.stringify({ verdict, parts: [], feedback: 'Feedback.', eeriness: 5, satisfaction: 5 });
let verdict;

beforeEach(() => {
  env.QRNG_API_KEY = 'test-key';
  env.ANTHROPIC_API_KEY = 'test-key';
  qrng.fetchHexStrings = async () => SAMPLE;
  verdict = 'pass';
  judgeAi.llm.chat = async () => reply(verdict);
});
afterEach(() => {
  qrng.fetchHexStrings = realFetch;
  judgeAi.llm.chat = realChat;
  env.QRNG_API_KEY = saved.qrng;
  env.ANTHROPIC_API_KEY = saved.ai;
});

async function member() {
  const { tokens, user } = await registerUser();
  await db.users.promoteToMember(user.id);
  return { token: tokens.accessToken, userId: user.id };
}

const start = (token, length) => api().post('/api/v1/series').set(bearer(token)).send({ length });
const active = (token) => api().get('/api/v1/series/active').set(bearer(token));
const list = (token) => api().get('/api/v1/series').set(bearer(token));

/** Submits an interpretation of the draw; resolves to the response. */
const submit = (token, drawId) =>
  api()
    .post(`/api/v1/clue-string/${drawId}/interpretation`)
    .set(bearer(token))
    .send({ text: 'HELL-OW: a hard place, then pain. The way through is hard.', source: 'text' });

/** One reading: draw a clue and interpret it. Resolves to { draw, judged } response bodies. */
async function reading(token) {
  const draw = (await api().post('/api/v1/clue-string').set(bearer(token)).send({ question: 'Today?' })).body.data;
  const judged = (await submit(token, draw.id)).body.data;
  return { draw, judged };
}

describe('NFT series', () => {
  test('requires a signed-in user', async () => {
    expect((await api().get('/api/v1/series')).status).toBe(401);
    expect((await api().post('/api/v1/series').send({ length: 1 })).status).toBe(401);
  });

  test('lists the lengths with their grids, rarities and rewards', async () => {
    const { token } = await member();
    const res = await api().get('/api/v1/series/options').set(bearer(token));
    expect(res.body.data.options.map((o) => [o.length, o.rows, o.cols, o.rarity, o.badge, o.nftEligible])).toEqual([
      [1, 1, 1, 'common', null, false],
      [2, 1, 2, 'common', null, false],
      [3, 1, 3, 'common', null, true],
      [6, 2, 3, 'epic', null, true],
      [12, 3, 4, 'mythic', null, true],
      [24, 4, 6, 'legendary', null, true],
    ]);
    expect(res.body.data.publish).toMatchObject({ free: true, price: { amountCents: 0, currency: env.PAYMENTS_CURRENCY } });
  });

  test('explorers: singles, twins and Level 1 only, and no converting', async () => {
    const { token, userId } = await member();
    await db.users.setMembershipType(userId, 'explorer');
    for (const length of [6, 12, 24]) {
      const refused = await start(token, length);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('LEVEL_NOT_ALLOWED');
    }
    expect((await start(token, 3)).status).toBe(201);
    let last;
    for (let i = 0; i < 3; i += 1) last = await reading(token);
    expect(last.judged.series.status).toBe('completed');

    const convert = await api().post(`/api/v1/series/${last.judged.series.id}/convert`).set(bearer(token)).send({});
    expect(convert.status).toBe(403);
    expect(convert.body.error.code).toBe('EXPLORER_CANNOT_PROFIT');
  });

  test('members only, one at a time, valid lengths only', async () => {
    const { tokens } = await registerUser();
    const refused = await start(tokens.accessToken, 6);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('MEMBERSHIP_REQUIRED');

    const { token } = await member();
    expect((await start(token, 5)).status).toBe(400);
    const started = await start(token, 6);
    expect(started.status).toBe(201);
    expect(started.body.data.series).toMatchObject({
      length: 6,
      rows: 2,
      cols: 3,
      rarity: 'epic',
      status: 'active',
      revealedTiles: [],
      revealedCount: 0,
      artworkKey: expect.stringMatching(/^butterfly_\d{2}$/),
      deadlineAt: expect.any(String),
    });
    // The reveal order stays on the server.
    expect(started.body.data.series.revealOrder).toBeUndefined();

    const second = await start(token, 2);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SERIES_ACTIVE');
  });

  test('each pass reveals one tile; a fail reveals nothing; the last tile completes it', async () => {
    const { token } = await member();
    await start(token, 2);

    const first = await reading(token);
    expect(first.draw.series).toMatchObject({ revealedCount: 0 });
    expect(first.judged.series.revealedCount).toBe(1);
    expect(first.judged.reading.tileIndex).toBe(first.judged.series.revealedTiles[0]);

    verdict = 'fail';
    const failed = await reading(token);
    expect(failed.judged.reading.tileIndex).toBeNull();
    expect(failed.judged.series).toMatchObject({ revealedCount: 1, status: 'active' });

    verdict = 'pass';
    const last = await reading(token);
    expect(last.judged.series).toMatchObject({ revealedCount: 2, status: 'completed', deadlineAt: null });
    expect([...last.judged.series.revealedTiles].sort()).toEqual([0, 1]);
    expect(last.judged.series.completedAt).toEqual(expect.any(String));

    // Completed: no active series, the NFT is in the list, and new readings stand alone.
    expect((await active(token)).body.data.series).toBeNull();
    expect((await list(token)).body.data.series).toHaveLength(1);
    const after = await reading(token);
    expect(after.draw.seriesId).toBeNull();
    expect(after.judged.series).toBeNull();
  });

  test('a single reading completes on its first pass, and earns an emblem that cannot become an NFT', async () => {
    const { token } = await member();
    await start(token, 1);
    const { judged } = await reading(token);
    expect(judged.series).toMatchObject({ length: 1, rarity: 'common', status: 'completed', revealedTiles: [0], nftEligible: false });
    expect(judged.series.artworkKey).toMatch(/^butterfly_\d{2}$/);

    const convert = await api().post(`/api/v1/series/${judged.series.id}/convert`).set(bearer(token)).send({});
    expect(convert.status).toBe(403);
    expect(convert.body.error.code).toBe('NOT_MINT_ELIGIBLE');
  });

  test('a reading not completed within 12 hours fails the series: its emblems stay, but it can never be an NFT', async () => {
    const { token, userId } = await member();
    const started = (await start(token, 6)).body.data.series;
    await reading(token); // passed: one emblem
    await api().post('/api/v1/clue-string').set(bearer(token)).send({ question: 'Later?' }); // never interpreted
    await db.testing.backdateDraws(userId, 12 * 60 * 60 * 1000);

    // The next reading is a plain reading: it doesn't revive or join the lost series.
    const late = await reading(token);
    expect(late.draw.seriesId).toBeNull();
    expect((await active(token)).body.data.series).toBeNull();
    // The one emblem earned stays in the gallery, unfinished.
    const kept = (await list(token)).body.data.series;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: started.id, status: 'failed', revealedCount: 1 });
    const convert = await api().post(`/api/v1/series/${started.id}/convert`).set(bearer(token)).send({});
    expect(convert.status).toBe(409);
    expect(convert.body.error.code).toBe('SERIES_NOT_COMPLETED');

    // A new series can start straight away.
    expect((await start(token, 2)).status).toBe(201);
  });

  test('a failed reading left alone past 12 hours fails the series; there is no limit between readings', async () => {
    const { token, userId } = await member();
    await start(token, 12);
    // No reading yet: the series waits however long it takes.
    await db.testing.backdateDraws(userId, 48 * 60 * 60 * 1000);
    expect((await active(token)).body.data.series).not.toBeNull();
    // A passed reading long ago doesn't end it either.
    await reading(token);
    await db.testing.backdateDraws(userId, 48 * 60 * 60 * 1000);
    expect((await active(token)).body.data.series).not.toBeNull();

    verdict = 'fail';
    await reading(token); // failed, attempts left, then left alone
    await db.testing.backdateDraws(userId, 12 * 60 * 60 * 1000);
    expect((await active(token)).body.data.series).toBeNull();
    expect((await list(token)).body.data.series).toEqual([expect.objectContaining({ status: 'failed', revealedCount: 1 })]);
  });

  test('each reading moves the deadline to 12 hours after it', async () => {
    const { token } = await member();
    await start(token, 6);
    const { draw } = await reading(token);
    const deadline = new Date(draw.series.deadlineAt).getTime();
    expect(deadline - new Date(draw.generatedAt).getTime()).toBe(env.READING_WINDOW_HOURS * 60 * 60 * 1000);
  });

  test('a failed reading may be resubmitted; failing all three attempts fails the series, its emblems kept', async () => {
    const { token } = await member();
    await start(token, 6);
    await reading(token); // a pass: one emblem

    verdict = 'fail';
    const { draw, judged } = await reading(token);
    expect(judged.reading).toMatchObject({ attempts: 1, attemptsLeft: 2 });
    expect(judged.series.status).toBe('active');
    const second = (await submit(token, draw.id)).body.data;
    expect(second.reading).toMatchObject({ attempts: 2, attemptsLeft: 1 });
    expect(second.series.status).toBe('active');

    const third = (await submit(token, draw.id)).body.data;
    expect(third.reading).toMatchObject({ attempts: 3, attemptsLeft: 0 });
    expect(third.series).toMatchObject({ status: 'failed', revealedCount: 1, failedAt: expect.any(String) });
    expect((await submit(token, draw.id)).body.error.code).toBe('NO_ATTEMPTS_LEFT');

    expect((await active(token)).body.data.series).toBeNull();
    expect((await list(token)).body.data.series).toEqual([expect.objectContaining({ status: 'failed', revealedCount: 1 })]);
    // A new series can be started straight away.
    expect((await start(token, 3)).status).toBe(201);
  });

  test('a resubmitted pass still reveals a tile', async () => {
    const { token } = await member();
    await start(token, 3);
    verdict = 'fail';
    const { draw } = await reading(token);
    verdict = 'pass';
    const res = (await submit(token, draw.id)).body.data;
    expect(res.reading).toMatchObject({ attempts: 2, attemptsLeft: 0 });
    expect(res.series.revealedCount).toBe(1);
  });

  test('another user cannot see your series', async () => {
    const a = await member();
    const b = await member();
    await start(a.token, 6);
    expect((await active(b.token)).body.data.series).toBeNull();
    expect((await list(b.token)).body.data.series).toEqual([]);
  });
});

describe('shuffledTiles', () => {
  test('is every tile exactly once', () => {
    for (const length of [1, 2, 3, 6, 12, 24]) {
      expect([...shuffledTiles(length)].sort((x, y) => x - y)).toEqual(Array.from({ length }, (_, i) => i));
    }
  });
});
