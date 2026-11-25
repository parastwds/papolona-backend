const db = require('../src/db');
const ai = require('../src/modules/journal/insights.ai');
const { qrng } = require('../src/modules/clue/clue.service');
const env = require('../src/config/env');
const { setupDB, resetData, teardownDB, api, registerUser, bearer, PASSWORD } = require('./helpers');

beforeAll(() => setupDB('insights'));
beforeEach(resetData);
afterAll(teardownDB);

const realChat = ai.llm.chat;
const realKey = env.ANTHROPIC_API_KEY;
let calls;
let reply;
beforeEach(() => {
  // Any key selects the Claude provider, whatever the local .env says; the call itself is replaced below.
  env.ANTHROPIC_API_KEY = 'test-key';
  calls = [];
  reply = JSON.stringify({ refined: 'Today I saw a butterfly; it reminded me of my childhood.' });
  ai.llm.chat = async (messages) => {
    calls.push(messages);
    return typeof reply === 'function' ? reply(calls.length) : reply;
  };
});
afterEach(() => {
  ai.llm.chat = realChat;
  env.ANTHROPIC_API_KEY = realKey;
});

// Today in UTC: the test's "local day".
const today = () => {
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { day: from.toISOString().slice(0, 10), from: from.toISOString(), to: to.toISOString() };
};

let n = 0;
const write = (token, text = 'I saw a butterfly today, it reminded me of my childhood') =>
  api().post('/api/v1/journal').set(bearer(token)).send({ text, source: 'text', clientId: `client-${Date.now()}-${n++}` });
const insights = (token, range = today()) => api().get('/api/v1/journal/insights').query(range).set(bearer(token));
const regenerate = (token, range = today()) => api().post('/api/v1/journal/insights').set(bearer(token)).send(range);

describe('GET /journal/insights', () => {
  test('requires a signed-in user', async () => {
    expect((await api().get('/api/v1/journal/insights').query(today())).status).toBe(401);
  });

  test('refines the day from its entries, with no questions', async () => {
    const { tokens } = await registerUser();
    await write(tokens.accessToken);
    await write(tokens.accessToken, 'Later a second butterfly landed near me.');

    const res = await insights(tokens.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      day: today().day,
      refined: 'Today I saw a butterfly; it reminded me of my childhood.',
      model: ai.llm.model(),
      entryCount: 2,
    });
    expect(res.body.data).not.toHaveProperty('questions');
    const prompt = calls[0][1].content;
    expect(prompt).toContain('I saw a butterfly today');
    expect(prompt).toContain('a second butterfly');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('includes the clue the entries were sealed with', async () => {
    const realFetch = qrng.fetchHexStrings;
    env.QRNG_API_KEY = 'test-key';
    qrng.fetchHexStrings = async () => ['48656c6c6f2021', '576f726c64']; // HELLOW
    try {
      const { tokens } = await registerUser();
      await write(tokens.accessToken);
      await api().post('/api/v1/clue-string').set(bearer(tokens.accessToken)).send({ question: 'What am I seeing?' });
      await insights(tokens.accessToken);
      expect(calls[0][1].content).toContain('Clue of the day: HELLOW');
    } finally {
      qrng.fetchHexStrings = realFetch;
      env.QRNG_API_KEY = undefined;
    }
  });

  test('reuses the saved reading until the day’s entries change', async () => {
    const { tokens } = await registerUser();
    await write(tokens.accessToken);
    await insights(tokens.accessToken);
    await insights(tokens.accessToken);
    expect(calls).toHaveLength(1);

    await write(tokens.accessToken, 'Another one in the evening.');
    expect((await insights(tokens.accessToken)).body.data.entryCount).toBe(2);
    expect(calls).toHaveLength(2);
  });

  test('POST asks the AI again even when nothing changed', async () => {
    const { tokens } = await registerUser();
    await write(tokens.accessToken);
    await insights(tokens.accessToken);
    reply = JSON.stringify({ refined: 'A new reading.' });
    const res = await regenerate(tokens.accessToken);
    expect(res.body.data.refined).toBe('A new reading.');
    expect(calls).toHaveLength(2);
    expect((await insights(tokens.accessToken)).body.data.refined).toBe('A new reading.');
  });

  test('only reads the requested day, and only your own entries', async () => {
    const { tokens } = await registerUser();
    const other = await registerUser();
    await write(other.tokens.accessToken, 'Someone else’s entry.');
    expect((await insights(tokens.accessToken)).body.error.code).toBe('NO_ENTRIES');

    await write(tokens.accessToken);
    const yesterday = today();
    const shift = (iso) => new Date(new Date(iso).getTime() - 24 * 60 * 60 * 1000).toISOString();
    const res = await insights(tokens.accessToken, { day: '2000-01-01', from: shift(yesterday.from), to: shift(yesterday.to) });
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test('accepts JSON wrapped in prose, and retries once when the reply is unusable', async () => {
    const { tokens } = await registerUser();
    await write(tokens.accessToken);
    reply = (call) => (call === 1 ? 'Sorry, here you go:' : 'Sure! ```json\n{"refined": "Wrapped."}\n```');
    const res = await insights(tokens.accessToken);
    expect(res.body.data.refined).toBe('Wrapped.');
    expect(calls).toHaveLength(2);
  });

  test('502 when the AI is down or keeps replying nonsense; nothing is saved', async () => {
    const { tokens, user } = await registerUser();
    await write(tokens.accessToken);
    reply = 'not json';
    const res = await insights(tokens.accessToken);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('AI_UNAVAILABLE');
    expect(await db.journalInsights.find(user.id, today().day)).toBeNull();
  });

  test('rejects a missing or impossible range', async () => {
    const { tokens } = await registerUser();
    const { day, from } = today();
    expect((await insights(tokens.accessToken, { day, from })).status).toBe(400);
    expect((await insights(tokens.accessToken, { day, from, to: from })).status).toBe(400);
    const twoDays = new Date(new Date(from).getTime() + 48 * 60 * 60 * 1000).toISOString();
    expect((await insights(tokens.accessToken, { day, from, to: twoDays })).status).toBe(400);
    expect((await insights(tokens.accessToken, { day: '4 Nov', from, to: today().to })).status).toBe(400);
  });

  test('deleting the account deletes the readings', async () => {
    const { tokens, user } = await registerUser();
    await write(tokens.accessToken);
    await insights(tokens.accessToken);
    expect(await db.journalInsights.find(user.id, today().day)).toBeTruthy();
    await api().delete('/api/v1/users/me').set(bearer(tokens.accessToken)).send({ password: PASSWORD });
    expect(await db.journalInsights.find(user.id, today().day)).toBeNull();
  });
});

describe('parseReply', () => {
  test('keeps the trimmed refined text and ignores anything else', () => {
    expect(ai.parseReply(JSON.stringify({ refined: ' R ', questions: ['Why?'] }))).toEqual({ refined: 'R' });
  });

  test('null without a refined text, so the model is asked again', () => {
    expect(ai.parseReply('{"questions": ["Why?"]}')).toBeNull();
    expect(ai.parseReply('{"refined": "  "}')).toBeNull();
    expect(ai.parseReply('no json here')).toBeNull();
  });

  test('describes the day for the model: the clue and the tidied entries', () => {
    const prompt = ai.describeDay([{ text: 'A heron  stood\nstill.', source: 'voice', clue: { clue: 'QWERTY' } }]);
    expect(prompt).toBe('Clue of the day: QWERTY\n\nEntries:\n- (spoken) A heron stood still.');
  });
});
