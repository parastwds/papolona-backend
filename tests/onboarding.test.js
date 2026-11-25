const { setupDB, resetData, teardownDB, api, ANSWERS_CREATOR_REVENUE } = require('./helpers');
const { score, normalizeAnswers } = require('../src/modules/onboarding/onboarding.service');
const db = require('../src/db');
const data = require('../src/seed/data');

beforeAll(() => setupDB('onboarding'));
beforeEach(resetData);
afterAll(teardownDB);

describe('App config', () => {
  test('GET /health reports DB up', async () => {
    const res = await api().get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'ok', db: true, driver: db.driver });
  });

  test('GET /app/config returns versions, maintenance and legal versions', async () => {
    const res = await api().get('/api/v1/app/config');
    expect(res.status).toBe(200);
    expect(res.body.data.minSupportedVersion).toEqual({ ios: '1.0.0', android: '1.0.0' });
    expect(res.body.data.maintenance.enabled).toBe(false);
    expect(res.body.data.legal).toEqual({ termsVersion: '1.0', privacyVersion: '1.0' });
  });

  test('content pages are gone: the app has its own text', async () => {
    const res = await api().get('/api/v1/content/welcome');
    expect(res.status).toBe(404);
  });

  test('unknown route returns 404 JSON', async () => {
    const res = await api().get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});

describe('Onboarding questionnaire', () => {
  test('GET questionnaire never exposes weights, readiness, tags or tie-break', async () => {
    const res = await api().get('/api/v1/onboarding/questionnaire');
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(4);
    expect(res.body.data.questions).toHaveLength(8);
    expect(res.body.data.questions[0].prompt).toBe('What best describes you?');
    expect(res.body.data.questions.filter((q) => q.multiple).map((q) => q.key)).toEqual(['goal', 'resources']);
    const raw = JSON.stringify(res.body);
    for (const secret of ['weights', 'tieBreak', 'points', 'readiness', '"tag"', 'cohorts']) expect(raw).not.toContain(secret);
  });

  test('submit scores on the server but never returns the cohort', async () => {
    const res = await api().post('/api/v1/onboarding/questionnaire/submit').send({ version: 4, answers: ANSWERS_CREATOR_REVENUE });
    expect(res.status).toBe(201);
    expect(db.isValidId(res.body.data.submissionId)).toBe(true);
    expect(res.body.data.cohort).toBeNull();
    expect(res.body.data.showCohortToUser).toBe(false);

    const stored = await db.submissions.findById(res.body.data.submissionId);
    expect(stored.cohort).toBe('creator');
    expect(stored.readinessScore).toBe(6);
    expect(stored.readinessTier).toBe('high');
    expect(stored.tags).toEqual(['engagement_guided', 'risk_balanced']);
    expect(stored.answers.find((a) => a.questionKey === 'resources').optionKeys).toEqual(['portfolio', 'audience']);
  });

  test('rejects missing, duplicate, unknown and invalid multi-select answers', async () => {
    const res = await api()
      .post('/api/v1/onboarding/questionnaire/submit')
      .send({
        version: 4,
        answers: [
          { questionKey: 'role', optionKey: 'artist' },
          { questionKey: 'role', optionKey: 'collector' },
          { questionKey: 'outcome', optionKeys: ['visibility', 'revenue'] }, // single-choice question
          { questionKey: 'resources', optionKeys: ['budget', 'none'] }, // "None yet" is exclusive
          { questionKey: 'goal', optionKey: 'zzz' },
          { questionKey: 'q99', optionKey: 'artist' },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ANSWERS');
    const fields = res.body.error.details.map((d) => d.field);
    expect(fields).toEqual(
      expect.arrayContaining(['role', 'outcome', 'resources', 'goal', 'q99', 'timeline', 'engagement', 'risk', 'project']),
    );
  });

  test('outdated version returns 409 so the app refetches', async () => {
    const res = await api().post('/api/v1/onboarding/questionnaire/submit').send({ version: 99, answers: ANSWERS_CREATOR_REVENUE });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('QUESTIONNAIRE_OUTDATED');
  });

  test('invalid body returns VALIDATION_ERROR', async () => {
    const res = await api().post('/api/v1/onboarding/questionnaire/submit').send({ version: '1', answers: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('an answer with both optionKey and optionKeys is rejected', async () => {
    const res = await api()
      .post('/api/v1/onboarding/questionnaire/submit')
      .send({ version: 4, answers: [{ questionKey: 'role', optionKey: 'artist', optionKeys: ['artist'] }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('malformed JSON returns INVALID_JSON', async () => {
    const res = await api()
      .post('/api/v1/onboarding/questionnaire/submit')
      .set('Content-Type', 'application/json')
      .send('{"version":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('cohort scoring (unit)', () => {
  const q = data.questionnaire;
  // role, goals (array), outcome, plus optional overrides for the readiness and tag questions.
  const place = (role, goals, outcome, rest = {}) =>
    score(
      q,
      normalizeAnswers([
        { questionKey: 'role', optionKey: role },
        { questionKey: 'goal', optionKeys: goals },
        { questionKey: 'outcome', optionKey: outcome },
        { questionKey: 'timeline', optionKey: rest.timeline ?? '3_12_months' },
        { questionKey: 'resources', optionKeys: rest.resources ?? ['none'] },
        { questionKey: 'engagement', optionKey: rest.engagement ?? 'guided' },
        { questionKey: 'risk', optionKey: rest.risk ?? 'balanced' },
        { questionKey: 'project', optionKey: rest.project ?? 'no' },
      ]),
    );
  const pts = (r, cohort) => r.scores.find((s) => s.cohort === cohort).score;

  test('there are four cohorts, with no investor, institution or brand', () => {
    expect(q.cohorts.map((c) => c.key)).toEqual(['creator', 'collector', 'patron', 'explorer']);
    const labels = JSON.stringify(q.questions);
    for (const gone of ['Investor', 'investment', 'Institution', 'Brand']) expect(labels).not.toContain(gone);
  });

  test.each([
    ['artist', ['sell_nfts'], 'revenue', 'creator'],
    ['artist', ['exhibit_sell'], 'prestige', 'creator'],
    ['collector', ['acquire'], 'collection', 'collector'],
    ['collector', ['commission'], 'innovation', 'patron'],
    ['patron', ['commission'], 'prestige', 'patron'],
    ['patron', ['acquire'], 'collection', 'collector'],
    ['other', ['acquire'], 'collection', 'collector'],
    ['other', ['learn'], 'visibility', 'explorer'],
  ])('%s + %j + %s -> %s', (role, goals, outcome, expected) => {
    expect(place(role, goals, outcome).cohort).toBe(expected);
  });

  test('"just exploring" pushes an undecided artist into explorer', () => {
    const r = place('artist', ['learn'], 'innovation', { timeline: 'exploring' });
    expect(pts(r, 'explorer')).toBe(6); // learn 3 + innovation 1 + exploring 2
    expect(r.cohort).toBe('explorer');
  });

  test('multi-select goal points are split between the chosen options', () => {
    const r = place('artist', ['sell_nfts', 'learn'], 'visibility');
    expect(pts(r, 'creator')).toBe(6); // 3 + 2 / 2 + 2
    expect(pts(r, 'explorer')).toBe(1.5); // 3 / 2
    expect(r.cohort).toBe('creator');
  });

  test('ticking every goal does not outweigh who the user is', () => {
    const allGoals = q.questions.find((x) => x.key === 'goal').options.map((o) => o.key);
    expect(place('collector', allGoals, 'innovation').cohort).toBe('collector');
  });

  test('a total tie goes to the cohort with more role + goal points', () => {
    // patron 3 + 0 + 1 = 4, collector 1 + 3 + 0 = 4; role+goal: collector 4, patron 3.
    const r = place('patron', ['acquire'], 'prestige');
    expect(pts(r, 'patron')).toBe(4);
    expect(pts(r, 'collector')).toBe(4);
    expect(r.cohort).toBe('collector');
  });

  test('a tie on both totals falls back to the fixed order', () => {
    // creator 3 + 2 = 5, explorer 3 + 2 = 5 (role+goal 3 each) -> creator comes before explorer.
    const r = place('artist', ['learn'], 'visibility', { timeline: 'exploring' });
    expect(pts(r, 'creator')).toBe(5);
    expect(pts(r, 'explorer')).toBe(5);
    expect(r.cohort).toBe('creator');
  });

  test('readiness tier: timeline + capped resources + project', () => {
    const tier = (rest) => {
      const { readinessScore, readinessTier } = place('artist', ['sell_nfts'], 'revenue', rest);
      return { readinessScore, readinessTier };
    };
    expect(tier({ timeline: '1_3_months', resources: ['budget', 'audience', 'team'], project: 'yes' })).toEqual({ readinessScore: 6, readinessTier: 'high' });
    expect(tier({ timeline: '3_12_months', resources: ['budget'], project: 'no' })).toEqual({ readinessScore: 2, readinessTier: 'medium' });
    expect(tier({ timeline: 'exploring', resources: ['none'], project: 'planning' })).toEqual({ readinessScore: 1, readinessTier: 'low' });
  });

  test('engagement and risk become tags and do not change the cohort', () => {
    const a = place('artist', ['sell_nfts'], 'revenue', { engagement: 'full_service', risk: 'experimental' });
    const b = place('artist', ['sell_nfts'], 'revenue', { engagement: 'guided', risk: 'conservative' });
    expect(a.tags).toEqual(['engagement_full_service', 'risk_experimental']);
    expect(a.scores).toEqual(b.scores);
    expect(a.cohort).toBe(b.cohort);
  });
});
