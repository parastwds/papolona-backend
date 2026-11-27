const env = require('../src/config/env');
const db = require('../src/db');
const { extractLetters, qrng } = require('../src/modules/clue/clue.service');
const judgeAi = require('../src/modules/clue/judge.ai');
const { setupDB, resetData, teardownDB, api, registerUser, bearer } = require('./helpers');

beforeAll(() => setupDB('clue'));
beforeEach(resetData);
afterAll(teardownDB);

const realFetch = qrng.fetchHexStrings;
// 'Hello', two non-letters (space, '!'), then 'World': the clue is HELLOW.
const SAMPLE = ['48656c6c6f2021', '576f726c64'];

beforeEach(() => {
  env.QRNG_API_KEY = 'test-key';  qrng.fetchHexStrings = async () => SAMPLE;
});
afterEach(() => {
  qrng.fetchHexStrings = realFetch;
  env.QRNG_API_KEY = undefined;
});

const realChat = judgeAi.llm.chat;
const realAiKey = env.ANTHROPIC_API_KEY;
let judgeCalls;
let judgeReply;
const passReply = JSON.stringify({
  verdict: 'pass',
  parts: [
    { part: 'hell', meaning: 'a hard place' },
    { part: 'OW', meaning: 'pain' },
  ],
  feedback: 'You used every letter and joined the parts into one message.',
  eeriness: 7,
  satisfaction: 6,
});
const failReply = JSON.stringify({ verdict: 'fail', parts: [], feedback: 'You never used the clue letters.' });
beforeEach(() => {
  env.ANTHROPIC_API_KEY = 'test-key';
  judgeCalls = [];
  judgeReply = passReply;
  judgeAi.llm.chat = async (messages) => {
    judgeCalls.push(messages);
    return typeof judgeReply === 'function' ? judgeReply(judgeCalls.length) : judgeReply;
  };
});
afterEach(() => {
  judgeAi.llm.chat = realChat;
  env.ANTHROPIC_API_KEY = realAiKey;
});

const INTERPRETATION = 'HELL-OW: hell is a hard place, OW is the sound of pain. Together: the door leads through pain.';
const interpret = (token, id, body = { text: INTERPRETATION, source: 'text' }) =>
  api().post(`/api/v1/clue-string/${id}/interpretation`).set(bearer(token)).send(body);

const QUESTION = 'What is the door I keep seeing?';
const generate = (token, question = QUESTION) => api().post('/api/v1/clue-string').set(bearer(token)).send({ question });
const status = (token) => api().get('/api/v1/clue-string').set(bearer(token));

describe('extractLetters', () => {
  test('reads byte pairs as ASCII and keeps only letters', () => {
    expect(extractLetters(SAMPLE)).toBe('HelloW');
  });

  test('the ANU sample has a single letter (0x52 = R)', () => {
    expect(extractLetters(['e9c201c236f13a9ff113', '89db8194338ad538e652'])).toBe('R');
  });

  test('continues into the next string when the first runs out', () => {
    expect(extractLetters(['4142', '2043444546'])).toBe('ABCDEF');
  });

  test('returns what it found when there are fewer than six', () => {
    expect(extractLetters(['4120', '2142'])).toBe('AB');
  });
});

describe('POST /clue-string', () => {
  test('requires a signed-in user', async () => {
    const res = await api().post('/api/v1/clue-string');
    expect(res.status).toBe(401);
  });

  test('answers 503 when the ANU key is not set', async () => {
    env.QRNG_API_KEY = undefined;
    const { tokens } = await registerUser();
    const res = await generate(tokens.accessToken);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CLUE_NOT_CONFIGURED');
  });

  test('a question is optional but at most 500 characters', async () => {
    const { tokens } = await registerUser();
    for (const body of [{ question: 'x'.repeat(501) }, { question: 42 }]) {
      const res = await api().post('/api/v1/clue-string').set(bearer(tokens.accessToken)).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details[0].field).toBe('question');
    }
    // A refused question costs nothing: the day's clue can still be drawn.
    expect((await generate(tokens.accessToken)).status).toBe(201);
  });

  test('returns six uppercase letters with the question, and three attempts to interpret them', async () => {
    const { tokens } = await registerUser();
    const res = await generate(tokens.accessToken, `  ${QUESTION}  `);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(String),
      clue: 'HELLOW',
      question: QUESTION,
      generatedAt: expect.any(String),
      interpretation: null,
      deadlineAt: expect.any(String),
      expired: false,
      attempts: 0,
      attemptsLeft: 3,
      maxAttempts: 3,
      promptAvailableAt: expect.any(String),
      ratings: null,
      seriesId: null,
      tileIndex: null,
      prompt: null,
      series: null,
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('keeps the letters it has and draws again when a response has fewer than six', async () => {
    const draws = [['e9c201c236f13a9ff113', '89db8194338ad538e652'], ['41424344454647']];
    qrng.fetchHexStrings = async () => draws.shift();
    const { tokens } = await registerUser();
    const res = await generate(tokens.accessToken);
    expect(res.body.data.clue).toBe('RABCDE');
  });

  test('no waiting between clues, but the last one must be interpreted first', async () => {
    const { tokens } = await registerUser();
    const first = (await generate(tokens.accessToken)).body.data;

    const again = await generate(tokens.accessToken);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INTERPRET_FIRST');
    expect(again.body.error.details.lastClue.clue).toBe('HELLOW');

    await interpret(tokens.accessToken, first.id);
    expect((await generate(tokens.accessToken)).status).toBe(201);
  });

  test('two requests at once produce only one clue', async () => {
    const { tokens } = await registerUser();
    const results = await Promise.all([generate(tokens.accessToken), generate(tokens.accessToken)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  test('a failed ANU call leaves the user free to draw again', async () => {
    qrng.fetchHexStrings = async () => ['0102', '0304'];
    const { tokens } = await registerUser();
    const failed = await generate(tokens.accessToken);
    expect(failed.status).toBe(502);

    qrng.fetchHexStrings = async () => SAMPLE;
    const res = await generate(tokens.accessToken);
    expect(res.status).toBe(201);
  });
});

describe('GET /clue-string', () => {
  test('before any clue: can generate, nothing to show', async () => {
    const { tokens } = await registerUser();
    const res = await status(tokens.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      canGenerate: true,
      lastClue: null,
      prompts: { stage: 'apprentice', limit: 90, used: 0, remaining: 90, resetsAt: expect.any(String) },
    });
  });

  test('after a clue: shows it; no new clue until it is interpreted', async () => {
    const { tokens } = await registerUser();
    await generate(tokens.accessToken);
    const res = await status(tokens.accessToken);
    expect(res.body.data.canGenerate).toBe(false);
    expect(res.body.data.lastClue).toEqual({
      id: expect.any(String),
      clue: 'HELLOW',
      question: QUESTION,
      generatedAt: expect.any(String),
      interpretation: null,
      deadlineAt: expect.any(String),
      expired: false,
      attempts: 0,
      attemptsLeft: 3,
      maxAttempts: 3,
      promptAvailableAt: expect.any(String),
      ratings: null,
      seriesId: null,
      tileIndex: null,
      prompt: null,
    });
  });
});

describe('GET /clue-string/history', () => {
  const history = (token, query = '') => api().get(`/api/v1/clue-string/history${query}`).set(bearer(token));

  test('requires a signed-in user', async () => {
    expect((await api().get('/api/v1/clue-string/history')).status).toBe(401);
  });

  test('pages your own readings newest first', async () => {
    const { tokens } = await registerUser();
    const other = await registerUser();
    // With no limit each clue is interpreted before the next is drawn.
    for (let i = 0; i < 5; i += 1) {
      const draw = await generate(tokens.accessToken, `Question number ${i}?`);
      await interpret(tokens.accessToken, draw.body.data.id);
    }
    await generate(other.tokens.accessToken, 'Someone else asking?');

    const first = await history(tokens.accessToken, '?limit=3');
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body.data.readings.map((r) => r.question)).toEqual([
      'Question number 4?',
      'Question number 3?',
      'Question number 2?',
    ]);
    expect(Object.keys(first.body.data.readings[0]).sort()).toEqual(['attempts', 'attemptsLeft', 'clue', 'deadlineAt', 'expired', 'generatedAt', 'id', 'interpretation', 'maxAttempts', 'prompt', 'promptAvailableAt', 'question', 'ratings', 'seriesId', 'tileIndex']);
    expect(first.body.data.nextCursor).toBe(first.body.data.readings[2].id);

    const second = (await history(tokens.accessToken, `?limit=3&before=${first.body.data.nextCursor}`)).body.data;
    expect(second.readings.map((r) => r.question)).toEqual(['Question number 1?', 'Question number 0?']);
    expect(second.nextCursor).toBeNull();

    const theirs = (await history(other.tokens.accessToken)).body.data;
    expect(theirs.readings.map((r) => r.question)).toEqual(['Someone else asking?']);
  });

  test('validates the cursor and limit', async () => {
    const { tokens } = await registerUser();
    expect((await history(tokens.accessToken)).body.data).toEqual({ readings: [], nextCursor: null });
    expect((await history(tokens.accessToken, '?limit=51')).status).toBe(400);
    expect((await history(tokens.accessToken, '?before=nope')).status).toBe(400);
  });
});

describe('GET /users/me/probation', () => {
  const probation = (token) => api().get('/api/v1/users/me/probation').set(bearer(token));

  test('requires a signed-in user', async () => {
    expect((await api().get('/api/v1/users/me/probation')).status).toBe(401);
  });

  test('a new account has done no readings yet', async () => {
    const { tokens } = await registerUser();
    const res = await probation(tokens.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      status: 'probation',
      readingsDone: 0,
      readingsRequired: 30,
      readingsStep: 3,
      readingsTarget: 30,
      readingsMet: false,
      daysDone: 0,
      daysRequired: 28,
      daysMet: false,
      endsAt: expect.any(String),
      complete: false,
    });
    const days = (new Date(res.body.data.endsAt) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(27.9);
    expect(days).toBeLessThanOrEqual(28);
  });

  test('complete after 28 days with 30 or more passed readings in a multiple of three', async () => {
    const { tokens, user } = await registerUser();
    const now = async () => (await probation(tokens.accessToken)).body.data;

    // 30 readings on day 0: the readings are there, the days are not.
    await db.testing.addPassedReadings(user.id, 30);
    expect(await now()).toMatchObject({ readingsDone: 30, readingsTarget: 30, readingsMet: true, daysMet: false, complete: false });

    await db.testing.backdateUser(user.id, 28);
    expect(await now()).toMatchObject({ daysDone: 28, daysMet: true, complete: true });

    // 31 and 32 are not multiples of three: they wait for 33.
    await db.testing.addPassedReadings(user.id, 1);
    expect(await now()).toMatchObject({ readingsDone: 31, readingsTarget: 33, readingsMet: false, complete: false });
    await db.testing.addPassedReadings(user.id, 1);
    expect(await now()).toMatchObject({ readingsDone: 32, readingsTarget: 33, complete: false });
    await db.testing.addPassedReadings(user.id, 1);
    expect(await now()).toMatchObject({ readingsDone: 33, readingsTarget: 33, readingsMet: true, complete: true });
  });

  test('after 28 days, fewer than 30 readings is not enough, even in a multiple of three', async () => {
    const { tokens, user } = await registerUser();
    await db.testing.backdateUser(user.id, 40);
    await db.testing.addPassedReadings(user.id, 27);
    expect((await probation(tokens.accessToken)).body.data).toMatchObject({
      readingsDone: 27,
      readingsTarget: 30,
      daysDone: 40,
      daysMet: true,
      complete: false,
    });
  });

  test('each passed interpretation is one reading; a fail or an uninterpreted clue is not; the target completes probation without changing the status', async () => {
    const saved = { readings: env.PROBATION_READINGS, step: env.PROBATION_STEP, days: env.PROBATION_DAYS };
    env.PROBATION_READINGS = 2;
    env.PROBATION_STEP = 1;
    env.PROBATION_DAYS = 0;
    try {
      const { tokens } = await registerUser();
      const drawAndInterpret = async () => {
        const draw = await generate(tokens.accessToken);
        return interpret(tokens.accessToken, draw.body.data.id);
      };

      const open = await generate(tokens.accessToken); // drawn, not interpreted yet
      expect((await probation(tokens.accessToken)).body.data.readingsDone).toBe(0);

      judgeReply = failReply;
      await interpret(tokens.accessToken, open.body.data.id);
      expect((await probation(tokens.accessToken)).body.data.readingsDone).toBe(0);

      judgeReply = passReply;
      const passed = await drawAndInterpret();
      expect(passed.body.data.probation).toMatchObject({ readingsDone: 1, readingsRequired: 2, complete: false });

      await drawAndInterpret();
      expect((await probation(tokens.accessToken)).body.data).toMatchObject({
        status: 'probation',
        readingsDone: 2,
        readingsRequired: 2,
        complete: true,
      });
    } finally {
      env.PROBATION_READINGS = saved.readings;
      env.PROBATION_STEP = saved.step;
      env.PROBATION_DAYS = saved.days;
    }
  });

  test('a failed draw is not a reading', async () => {
    qrng.fetchHexStrings = async () => ['0102'];
    const { tokens } = await registerUser();
    await generate(tokens.accessToken);
    expect((await probation(tokens.accessToken)).body.data.readingsDone).toBe(0);
  });

  test('members are complete', async () => {
    const { tokens, user } = await registerUser();
    await db.users.update(user.id, { status: 'member' });
    expect((await probation(tokens.accessToken)).body.data).toMatchObject({ status: 'member', complete: true });
  });
});

describe('POST /clue-string/:id/interpretation', () => {
  test('requires a signed-in user', async () => {
    const res = await api()
      .post('/api/v1/clue-string/01900000-0000-7000-8000-000000000000/interpretation')
      .send({ text: INTERPRETATION, source: 'text' });
    expect(res.status).toBe(401);
  });

  test('a pass: the judge sees the question, clue and interpretation; the verdict is saved and shown everywhere', async () => {
    const { tokens } = await registerUser();
    const draw = (await generate(tokens.accessToken)).body.data;

    const res = await interpret(tokens.accessToken, draw.id, { text: INTERPRETATION, source: 'voice' });
    expect(res.status).toBe(201);
    expect(res.body.data.reading).toMatchObject({
      id: draw.id,
      clue: 'HELLOW',
      question: QUESTION,
      interpretation: {
        text: INTERPRETATION,
        source: 'voice',
        verdict: 'pass',
        parts: [
          { part: 'HELL', meaning: 'a hard place' },
          { part: 'OW', meaning: 'pain' },
        ],
        feedback: 'You used every letter and joined the parts into one message.',
      },
    });
    expect(res.body.data.probation).toMatchObject({ readingsDone: 1 });

    const prompt = judgeCalls[0][1].content;
    expect(prompt).toContain(QUESTION);
    expect(prompt).toContain('HELLOW');
    expect(prompt).toContain('the door leads through pain');

    expect((await status(tokens.accessToken)).body.data.lastClue.interpretation.verdict).toBe('pass');
    const history = await api().get('/api/v1/clue-string/history').set(bearer(tokens.accessToken));
    expect(history.body.data.readings[0].interpretation.verdict).toBe('pass');
  });

  test('a fail is saved with feedback and does not count; it may be resubmitted three times in all, then the reading is closed', async () => {
    const { tokens } = await registerUser();
    const draw = (await generate(tokens.accessToken)).body.data;
    judgeReply = failReply;

    const res = await interpret(tokens.accessToken, draw.id, { text: 'I just feel good about today, nothing more.', source: 'text' });
    expect(res.status).toBe(201);
    expect(res.body.data.reading.interpretation).toMatchObject({ verdict: 'fail', parts: [], feedback: 'You never used the clue letters.' });
    expect(res.body.data.reading).toMatchObject({ attempts: 1, attemptsLeft: 2, maxAttempts: 3 });
    expect(res.body.data.probation.readingsDone).toBe(0);

    expect((await interpret(tokens.accessToken, draw.id)).body.data.reading).toMatchObject({ attempts: 2, attemptsLeft: 1 });
    const last = (await interpret(tokens.accessToken, draw.id)).body.data;
    expect(last.reading).toMatchObject({ attempts: 3, attemptsLeft: 0 });
    expect(last.series).toBeNull();

    judgeReply = passReply;
    const again = await interpret(tokens.accessToken, draw.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('NO_ATTEMPTS_LEFT');
    expect(judgeCalls).toHaveLength(3);
    // The apprentice starts a new reading.
    expect((await status(tokens.accessToken)).body.data.canGenerate).toBe(true);
    expect((await generate(tokens.accessToken)).status).toBe(201);
  });

  test('a reading not completed within 12 hours fails: no more attempts or prompts, and a new clue can be drawn', async () => {
    const { tokens, user } = await registerUser();
    const draw = (await generate(tokens.accessToken)).body.data;
    expect(new Date(draw.deadlineAt) - new Date(draw.generatedAt)).toBe(12 * 60 * 60 * 1000);

    judgeReply = failReply;
    await interpret(tokens.accessToken, draw.id);
    await db.testing.backdateDraws(user.id, 12 * 60 * 60 * 1000);

    const late = await interpret(tokens.accessToken, draw.id);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('READING_EXPIRED');
    const prompted = await api().post(`/api/v1/clue-string/${draw.id}/prompt`).set(bearer(tokens.accessToken));
    expect(prompted.body.error.code).toBe('READING_EXPIRED');
    expect(judgeCalls).toHaveLength(1);

    const { body } = await status(tokens.accessToken);
    expect(body.data.lastClue).toMatchObject({ expired: true, attemptsLeft: 0 });
    expect(body.data.canGenerate).toBe(true);
    expect((await generate(tokens.accessToken)).status).toBe(201);
  });

  test('an uninterpreted clue past 12 hours no longer blocks the next one', async () => {
    const { tokens, user } = await registerUser();
    await generate(tokens.accessToken);
    expect((await generate(tokens.accessToken)).body.error.code).toBe('INTERPRET_FIRST');
    await db.testing.backdateDraws(user.id, 12 * 60 * 60 * 1000 + 1000);
    expect((await generate(tokens.accessToken)).status).toBe(201);
  });

  test('a resubmitted pass counts; a passed reading cannot be judged again', async () => {
    const { tokens } = await registerUser();
    const draw = (await generate(tokens.accessToken)).body.data;
    judgeReply = failReply;
    await interpret(tokens.accessToken, draw.id);

    judgeReply = passReply;
    const res = await interpret(tokens.accessToken, draw.id);
    expect(res.body.data.reading).toMatchObject({ attempts: 2, attemptsLeft: 0, interpretation: { verdict: 'pass' } });
    expect(res.body.data.probation.readingsDone).toBe(1);

    const again = await interpret(tokens.accessToken, draw.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_JUDGED');
  });

  test('only the latest clue can be interpreted, and only your own', async () => {
    // A failed reading left for a new one cannot be resubmitted any more.
    const { tokens } = await registerUser();
    const first = (await generate(tokens.accessToken)).body.data;
    judgeReply = failReply;
    await interpret(tokens.accessToken, first.id);
    await generate(tokens.accessToken);
    const res = await interpret(tokens.accessToken, first.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('READING_CLOSED');

    const other = await registerUser();
    const theirs = (await generate(other.tokens.accessToken)).body.data;
    expect((await interpret(tokens.accessToken, theirs.id)).body.error.code).toBe('READING_CLOSED');
    expect(judgeCalls).toHaveLength(1);
  });

  test('with no limit, readings follow one another as soon as each is interpreted', async () => {
    const { tokens } = await registerUser();
    const first = (await generate(tokens.accessToken)).body.data;

    // No skipping: the open clue must be interpreted before another is drawn.
    const early = await generate(tokens.accessToken);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('INTERPRET_FIRST');
    expect(early.body.error.details.lastClue.id).toBe(first.id);

    expect((await interpret(tokens.accessToken, first.id)).status).toBe(201);
    const second = await generate(tokens.accessToken);
    expect(second.status).toBe(201);
    expect((await interpret(tokens.accessToken, second.body.data.id)).status).toBe(201);
    expect((await generate(tokens.accessToken)).status).toBe(201);
    expect((await status(tokens.accessToken)).body.data.canGenerate).toBe(false);
  });

  test('retries once on an unusable reply; 502 and nothing saved when the judge keeps failing, so it can be tried again', async () => {
    const { tokens } = await registerUser();
    const draw = (await generate(tokens.accessToken)).body.data;

    judgeReply = 'not json';
    const down = await interpret(tokens.accessToken, draw.id);
    expect(down.status).toBe(502);
    expect(down.body.error.code).toBe('AI_UNAVAILABLE');
    expect((await status(tokens.accessToken)).body.data.lastClue.interpretation).toBeNull();

    judgeReply = (call) => (call === 3 ? 'Here: ' + passReply : '{"verdict": "maybe"}');
    const res = await interpret(tokens.accessToken, draw.id);
    expect(res.status).toBe(201);
    expect(res.body.data.reading.interpretation.verdict).toBe('pass');
  });

  test('rejects an interpretation that is too short, a bad source or a bad id', async () => {
    const { tokens } = await registerUser();
    const draw = (await generate(tokens.accessToken)).body.data;
    expect((await interpret(tokens.accessToken, draw.id, { text: 'HELL', source: 'text' })).status).toBe(400);
    expect((await interpret(tokens.accessToken, draw.id, { text: INTERPRETATION, source: 'video' })).status).toBe(400);
    expect((await interpret(tokens.accessToken, 'nope')).status).toBe(400);
    expect(judgeCalls).toHaveLength(0);
  });
});

describe('judge parseVerdict', () => {
  test('keeps the verdict, cleaned parts and feedback', () => {
    expect(
      judgeAi.parseVerdict(
        JSON.stringify({ verdict: 'fail', parts: [{ part: ' ab ', meaning: ' x ' }, { part: '', meaning: 'y' }, 3], feedback: ' F ' }),
      ),
    ).toEqual({ verdict: 'fail', parts: [{ part: 'AB', meaning: 'x' }], feedback: 'F', eeriness: null, satisfaction: null });
  });

  test('ratings are rounded into 1–10; missing or junk ratings are null', () => {
    const parse = (extra) => judgeAi.parseVerdict(JSON.stringify({ verdict: 'pass', parts: [], feedback: 'F', ...extra }));
    expect(parse({ eeriness: 7.6, satisfaction: '3' })).toMatchObject({ eeriness: 8, satisfaction: 3 });
    expect(parse({ eeriness: 42, satisfaction: -5 })).toMatchObject({ eeriness: 10, satisfaction: 1 });
    expect(parse({ eeriness: 'eerie', satisfaction: null })).toMatchObject({ eeriness: null, satisfaction: null });
  });

  test('null without a pass/fail verdict or without feedback', () => {
    expect(judgeAi.parseVerdict('{"verdict": "maybe", "feedback": "F"}')).toBeNull();
    expect(judgeAi.parseVerdict('{"verdict": "pass", "feedback": " "}')).toBeNull();
    expect(judgeAi.parseVerdict('no json')).toBeNull();
  });
});

describe('reading ratings', () => {
  const rate = (token, id, body) => api().put(`/api/v1/clue-string/${id}/rating`).set(bearer(token)).send(body);

  test('the AI judge rates eeriness and satisfaction with its verdict', async () => {
    const { tokens } = await registerUser();
    const draw = (await generate(tokens.accessToken)).body.data;
    expect(draw.ratings).toBeNull();

    const res = await interpret(tokens.accessToken, draw.id);
    expect(res.body.data.reading.ratings).toEqual({ user: null, ai: { eeriness: 7, satisfaction: 6 } });
    expect(judgeCalls[0][0].content).toMatch(/eeriness/);
  });

  test('the user rates a reading 1–10 and may change it; it shows in the history', async () => {
    const { tokens } = await registerUser();
    const draw = (await generate(tokens.accessToken)).body.data;
    await interpret(tokens.accessToken, draw.id);

    const first = await rate(tokens.accessToken, draw.id, { eeriness: 9, satisfaction: 4 });
    expect(first.status).toBe(200);
    expect(first.body.data.ratings).toMatchObject({
      user: { eeriness: 9, satisfaction: 4 },
      ai: { eeriness: 7, satisfaction: 6 },
    });
    await rate(tokens.accessToken, draw.id, { eeriness: 5, satisfaction: 5 });

    const history = await api().get('/api/v1/clue-string/history').set(bearer(tokens.accessToken));
    expect(history.body.data.readings[0].ratings.user).toMatchObject({ eeriness: 5, satisfaction: 5 });
  });

  test('the app rates satisfaction alone (five stars as 2–10); an earlier eeriness is kept', async () => {
    const { tokens } = await registerUser();
    const draw = (await generate(tokens.accessToken)).body.data;
    await interpret(tokens.accessToken, draw.id);

    const stars = await rate(tokens.accessToken, draw.id, { satisfaction: 8 });
    expect(stars.status).toBe(200);
    expect(stars.body.data.ratings.user).toMatchObject({ eeriness: null, satisfaction: 8 });

    await rate(tokens.accessToken, draw.id, { eeriness: 3, satisfaction: 4 });
    const again = await rate(tokens.accessToken, draw.id, { satisfaction: 10 });
    expect(again.body.data.ratings.user).toMatchObject({ eeriness: 3, satisfaction: 10 });
  });

  test('anyone may draw a clue without a question; it is saved blank', async () => {
    const { tokens } = await registerUser();
    const res = await api().post('/api/v1/clue-string').set(bearer(tokens.accessToken)).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.question).toBe('');
    await interpret(tokens.accessToken, res.body.data.id);
    expect(judgeCalls.at(-1)[1].content).toMatch(/left it blank/);
  });

  test('ratings must be whole numbers 1–10, and only for your own readings', async () => {
    const { tokens } = await registerUser();
    const draw = (await generate(tokens.accessToken)).body.data;
    expect((await rate(tokens.accessToken, draw.id, { eeriness: 0, satisfaction: 5 })).status).toBe(400);
    expect((await rate(tokens.accessToken, draw.id, { eeriness: 11, satisfaction: 5 })).status).toBe(400);
    expect((await rate(tokens.accessToken, draw.id, { eeriness: 5.5, satisfaction: 5 })).status).toBe(400);
    expect((await rate(tokens.accessToken, draw.id, { eeriness: 5 })).status).toBe(400);
    expect((await rate(tokens.accessToken, draw.id, { satisfaction: 0 })).status).toBe(400);

    const other = await registerUser();
    expect((await rate(other.tokens.accessToken, draw.id, { eeriness: 5, satisfaction: 5 })).status).toBe(404);
  });
});

describe('POST /clue-string/:id/prompt', () => {
  const { PROMPTS_PER_MONTH, PROMPT_TIMING } = require('../src/modules/clue/clue.service');
  // The options open five minutes after the draw; most tests skip the wait.
  const realDelay = PROMPT_TIMING.delayMinutes;
  beforeEach(() => {
    PROMPT_TIMING.delayMinutes = 0;
  });
  afterEach(() => {
    PROMPT_TIMING.delayMinutes = realDelay;
  });
  const promptAi = require('../src/modules/clue/prompt.ai');
  const promptReply = JSON.stringify({
    options: [
      { parts: [{ part: 'HELL', meaning: 'a hard place' }, { part: 'OW', meaning: 'a cry of pain' }] },
      { parts: [{ part: 'HE', meaning: 'a man' }, { part: 'LLOW', meaning: 'sounds like low' }] },
      // Does not spell HELLOW: dropped.
      { parts: [{ part: 'HELLO', meaning: 'a greeting' }] },
    ],
  });
  const prompt = (token, id) => api().post(`/api/v1/clue-string/${id}/prompt`).set(bearer(token));

  test('apprentices have 90 a month: the AI offers splits that spell the clue, and tapping again is free', async () => {
    const { tokens } = await registerUser();
    expect((await status(tokens.accessToken)).body.data.prompts).toMatchObject({
      stage: 'apprentice',
      limit: 90,
      used: 0,
      remaining: 90,
      resetsAt: expect.any(String),
    });
    const draw = (await generate(tokens.accessToken)).body.data;
    expect(draw.prompt).toBeNull();
    judgeReply = promptReply;

    const res = await prompt(tokens.accessToken, draw.id);
    expect(res.status).toBe(201);
    expect(res.body.data.reading.prompt).toEqual([
      { parts: [{ part: 'HELL', meaning: 'a hard place' }, { part: 'OW', meaning: 'a cry of pain' }] },
      { parts: [{ part: 'HE', meaning: 'a man' }, { part: 'LLOW', meaning: 'sounds like low' }] },
    ]);
    expect(res.body.data.prompts).toMatchObject({ used: 1, remaining: 89 });
    expect(judgeCalls[0][1].content).toContain('Clue: HELLOW');
    expect(judgeCalls[0][1].content).toContain(QUESTION);

    const again = await prompt(tokens.accessToken, draw.id);
    expect(again.body.data.reading.prompt).toEqual(res.body.data.reading.prompt);
    expect(again.body.data.prompts.used).toBe(1);
    expect(judgeCalls).toHaveLength(1);
    expect((await status(tokens.accessToken)).body.data).toMatchObject({
      lastClue: { prompt: res.body.data.reading.prompt },
      prompts: { used: 1, remaining: 89 },
    });
  });

  test('the options open five minutes after the draw; a failed reading may be prompted before it is resubmitted', async () => {
    PROMPT_TIMING.delayMinutes = 5;
    const { tokens } = await registerUser();
    const draw = (await generate(tokens.accessToken)).body.data;
    expect(new Date(draw.promptAvailableAt) - new Date(draw.generatedAt)).toBe(5 * 60 * 1000);

    const early = await prompt(tokens.accessToken, draw.id);
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: 'PROMPT_NOT_YET', details: { promptAvailableAt: draw.promptAvailableAt } });
    expect(judgeCalls).toHaveLength(0);
    expect((await status(tokens.accessToken)).body.data.prompts.used).toBe(0);

    judgeReply = failReply;
    await interpret(tokens.accessToken, draw.id);
    PROMPT_TIMING.delayMinutes = 0;
    judgeReply = promptReply;
    const res = await prompt(tokens.accessToken, draw.id);
    expect(res.status).toBe(201);
    expect(res.body.data.prompts.used).toBe(1);
  });

  test('members have 30 a month', async () => {
    const { tokens, user } = await registerUser();
    await db.users.update(user.id, { status: 'member' });
    expect((await status(tokens.accessToken)).body.data.prompts).toMatchObject({ stage: 'member', limit: 30, remaining: 30 });
  });

  test('once the month is used up: 409 NO_PROMPTS_LEFT, and the AI is not asked', async () => {
    const realLimit = PROMPTS_PER_MONTH.apprentice;
    PROMPTS_PER_MONTH.apprentice = 1;
    try {
      const { tokens } = await registerUser();
      const first = (await generate(tokens.accessToken)).body.data;
      judgeReply = promptReply;
      expect((await prompt(tokens.accessToken, first.id)).status).toBe(201);
      judgeReply = passReply;
      await interpret(tokens.accessToken, first.id);

      const second = (await generate(tokens.accessToken)).body.data;
      const calls = judgeCalls.length;
      const res = await prompt(tokens.accessToken, second.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'NO_PROMPTS_LEFT', details: { prompts: { remaining: 0, used: 1 } } });
      expect(judgeCalls).toHaveLength(calls);
    } finally {
      PROMPTS_PER_MONTH.apprentice = realLimit;
    }
  });

  test('only the latest clue, before it is judged', async () => {
    const { tokens } = await registerUser();
    const first = (await generate(tokens.accessToken)).body.data;
    const other = await registerUser();
    expect((await prompt(other.tokens.accessToken, first.id)).body.error.code).toBe('READING_CLOSED');
    await interpret(tokens.accessToken, first.id);
    expect((await prompt(tokens.accessToken, first.id)).body.error.code).toBe('ALREADY_JUDGED');

    expect((await generate(tokens.accessToken)).status).toBe(201);
    expect((await prompt(tokens.accessToken, first.id)).body.error.code).toBe('READING_CLOSED');
  });

  test('502 and nothing used when the AI keeps sending unusable splits', async () => {
    const { tokens } = await registerUser();
    const draw = (await generate(tokens.accessToken)).body.data;
    judgeReply = JSON.stringify({ options: [{ parts: [{ part: 'HELLO', meaning: 'hi' }] }] });
    const res = await prompt(tokens.accessToken, draw.id);
    expect(res.status).toBe(502);
    expect((await status(tokens.accessToken)).body.data).toMatchObject({ lastClue: { prompt: null }, prompts: { used: 0 } });
  });

  test('parseOptions keeps distinct splits that spell the clue, needs at least two', () => {
    const one = { parts: [{ part: 'hell', meaning: 'a hard place ' }, { part: 'o-w', meaning: 'pain' }] };
    const two = { parts: [{ part: 'HE', meaning: 'a man' }, { part: 'LLOW', meaning: 'low' }] };
    expect(promptAi.parseOptions(JSON.stringify({ options: [one, one, two] }), 'HELLOW')).toEqual({
      options: [
        { parts: [{ part: 'HELL', meaning: 'a hard place' }, { part: 'OW', meaning: 'pain' }] },
        { parts: [{ part: 'HE', meaning: 'a man' }, { part: 'LLOW', meaning: 'low' }] },
      ],
    });
    expect(promptAi.parseOptions(JSON.stringify({ options: [one, one] }), 'HELLOW')).toBeNull();
    expect(promptAi.parseOptions(JSON.stringify({ options: [one, { parts: [{ part: 'HE', meaning: '' }, { part: 'LLOW', meaning: 'x' }] }] }), 'HELLOW')).toBeNull();
    expect(promptAi.parseOptions('nope', 'HELLOW')).toBeNull();
  });
});
