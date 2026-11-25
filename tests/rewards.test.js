const env = require('../src/config/env');
const db = require('../src/db');
const { qrng } = require('../src/modules/clue/clue.service');
const judgeAi = require('../src/modules/clue/judge.ai');
const { publicName } = require('../src/modules/artwork/artwork.service');
const { setupDB, resetData, teardownDB, api, registerUser, bearer } = require('./helpers');

beforeAll(() => setupDB('rewards'));
beforeEach(resetData);
afterAll(teardownDB);

const SAMPLE = ['48656c6c6f2021', '576f726c64'];
const realFetch = qrng.fetchHexStrings;
const realChat = judgeAi.llm.chat;
const saved = {
  qrng: env.QRNG_API_KEY,
  ai: env.ANTHROPIC_API_KEY,
  demo: env.DEMO_PAYMENTS,
};
const reply = JSON.stringify({
  verdict: 'pass',
  parts: [{ part: 'HELL', meaning: 'A hard place.' }],
  feedback: 'Feedback.',
  eeriness: 5,
  satisfaction: 5,
});

beforeEach(() => {
  env.QRNG_API_KEY = 'test-key';
  env.ANTHROPIC_API_KEY = 'test-key';
  env.DEMO_PAYMENTS = true;
  qrng.fetchHexStrings = async () => SAMPLE;
  judgeAi.llm.chat = async () => reply;
});
afterEach(() => {
  qrng.fetchHexStrings = realFetch;
  judgeAi.llm.chat = realChat;
  env.QRNG_API_KEY = saved.qrng;
  env.ANTHROPIC_API_KEY = saved.ai;
  env.DEMO_PAYMENTS = saved.demo;
});

async function member(name = 'Asha Verma') {
  const { tokens, user } = await registerUser({ name });
  await db.users.promoteToMember(user.id);
  return { token: tokens.accessToken, userId: user.id };
}

async function reading(token) {
  const draw = (await api().post('/api/v1/clue-string').set(bearer(token)).send({ question: 'Today?' })).body.data;
  return (
    await api()
      .post(`/api/v1/clue-string/${draw.id}/interpretation`)
      .set(bearer(token))
      .send({ text: 'HELL-OW: a hard place, then pain. The way through is hard.', source: 'text' })
  ).body.data;
}

/** Starts a series of `length` and passes every reading. Resolves to the completed series. */
async function complete(token, length) {
  const started = await api().post('/api/v1/series').set(bearer(token)).send({ length });
  expect(started.status).toBe(201);
  let judged;
  for (let i = 0; i < length; i += 1) judged = await reading(token);
  expect(judged.series.status).toBe('completed');
  return judged.series;
}

const publish = (token, id) => api().post(`/api/v1/series/${id}/publish`).set(bearer(token));
const mintChoice = (token, id, choice) =>
  api().put(`/api/v1/series/${id}/mint-choice`).set(bearer(token)).send({ choice });

describe('rewards', () => {
  test('single and twin earn no badge and are not mint-eligible', async () => {
    const { token } = await member();
    const single = await complete(token, 1);
    expect(single).toMatchObject({ rarity: 'common', badges: [], nftEligible: false });
    const twin = await complete(token, 2);
    expect(twin).toMatchObject({ rarity: 'common', badges: [], nftEligible: false });
  });

  test('3, 6, 12 and 24 earn a butterfly emblem, rarer with length, and no badges', async () => {
    const { token } = await member();
    const expected = { 3: 'common', 6: 'epic', 12: 'mythic', 24: 'legendary' };
    for (const length of [3, 6, 12, 24]) {
      const done = await complete(token, length);
      expect(done).toMatchObject({ length, rarity: expected[length], nftEligible: true, badges: [], mintChoice: null });
      expect(done.artworkKey).toMatch(/^butterfly_\d{2}$/);
    }
    // Badges are no longer awarded.
    expect((await api().get('/api/v1/artwork/badges/me').set(bearer(token))).body.data.badges).toEqual([]);
  });

  test('mint choice: completed 3/6/12/24 series only', async () => {
    const { token } = await member();
    const twin = await complete(token, 2);
    const refused = await mintChoice(token, twin.id, 'mint');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('NOT_MINT_ELIGIBLE');
    expect((await publish(token, twin.id)).body.error.code).toBe('NOT_PUBLISHABLE');

    const triple = await complete(token, 3);
    expect((await mintChoice(token, triple.id, 'bogus')).status).toBe(400);
    const chosen = await mintChoice(token, triple.id, 'mint_poc');
    expect(chosen.status).toBe(200);
    expect(chosen.body.data.series.mintChoice).toBe('mint_poc');

    const other = await member();
    expect((await mintChoice(other.token, triple.id, 'keep')).status).toBe(404);
  });

  test('a published triple joins the collective artwork', async () => {
    const { token } = await member();
    const triple = await complete(token, 3);
    expect((await publish(token, triple.id)).status).toBe(201);
    const wall = (await api().get('/api/v1/artwork/wall').set(bearer(token))).body.data;
    expect(wall.tiles.map((t) => t.id)).toEqual([triple.id]);
  });

  test('publishing: completed series only, free, once, then on the wall with its meanings', async () => {
    const { token, userId } = await member('Ada Lovelace');
    await api().post('/api/v1/series').set(bearer(token)).send({ length: 12 });
    const { series: active } = await reading(token);
    const early = await publish(token, active.id);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('SERIES_NOT_COMPLETED');
    for (let i = 1; i < 12; i += 1) await reading(token);

    const [first, second] = await Promise.all([publish(token, active.id), publish(token, active.id)]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const ok = first.status === 201 ? first : second;
    expect(ok.body.data.payment).toBeNull();
    expect(ok.body.data.series.publishedAt).toEqual(expect.any(String));
    expect(await db.payments.list(userId)).toEqual([]);

    const viewer = await member();
    const wall = (await api().get('/api/v1/artwork/wall').set(bearer(viewer.token))).body.data;
    expect(wall.tiles).toHaveLength(1);
    expect(wall.tiles[0]).toMatchObject({
      id: active.id,
      owner: { id: userId, name: 'Ada L.' },
      creator: { id: userId, name: 'Ada L.' },
    });
    expect(wall.tiles[0].badges).toEqual([]);
    expect(wall.nextBefore).toBeNull();

    const opened = (await api().get(`/api/v1/artwork/wall/${active.id}`).set(bearer(viewer.token))).body.data;
    expect(opened.readings).toHaveLength(12);
    expect(opened.readings[0]).toMatchObject({ clue: expect.any(String), parts: [{ part: 'HELL', meaning: 'A hard place.' }] });

    const gallery = (await api().get(`/api/v1/artwork/members/${userId}`).set(bearer(viewer.token))).body.data;
    expect(gallery.member.name).toBe('Ada L.');
    expect(gallery.tiles.map((t) => t.id)).toEqual([active.id]);
  });

  test('a public series can be made private again, and public again, without selling it', async () => {
    const { token } = await member();
    const triple = await complete(token, 3);
    const unpublish = (id) => api().delete(`/api/v1/series/${id}/publish`).set(bearer(token));
    const wallIds = async () => (await api().get('/api/v1/artwork/wall').set(bearer(token))).body.data.tiles.map((t) => t.id);

    expect((await publish(token, triple.id)).body.data.series.listing).toBeNull();
    expect(await wallIds()).toEqual([triple.id]);

    const hidden = await unpublish(triple.id);
    expect(hidden.status).toBe(200);
    expect(hidden.body.data.series).toMatchObject({ id: triple.id, publishedAt: null });
    expect(await wallIds()).toEqual([]);
    expect((await api().get(`/api/v1/artwork/wall/${triple.id}`).set(bearer(token))).status).toBe(404);
    // Already private: nothing to do.
    expect((await unpublish(triple.id)).body.data.series.publishedAt).toBeNull();

    expect((await publish(token, triple.id)).status).toBe(201);
    expect(await wallIds()).toEqual([triple.id]);

    const other = await member();
    expect((await api().delete(`/api/v1/series/${triple.id}/publish`).set(bearer(other.token))).status).toBe(404);
  });

  test('unpublished series stay off the wall', async () => {
    const { token } = await member();
    const done = await complete(token, 12);
    expect((await api().get('/api/v1/artwork/wall').set(bearer(token))).body.data.tiles).toEqual([]);
    expect((await api().get(`/api/v1/artwork/wall/${done.id}`).set(bearer(token))).status).toBe(404);
  });

  test('publishing is free, so it works with payments off', async () => {
    env.DEMO_PAYMENTS = false;
    const { token } = await member();
    const done = await complete(token, 12);
    expect((await publish(token, done.id)).status).toBe(201);
  });

  test('publicName', () => {
    expect(publicName('Ada Lovelace')).toBe('Ada L.');
    expect(publicName('Cher')).toBe('Cher');
    expect(publicName('  ')).toBe('Member');
  });
});
