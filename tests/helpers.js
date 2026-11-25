const request = require('supertest');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { seed } = require('../src/seed/seed');
const { outbox } = require('../src/utils/mailer');

/** Each test file gets its own in-memory PostgreSQL (PGlite) with the migrations applied. */
async function setupDB() {
  await db.connect(db.IN_MEMORY_URL);
  await db.testing.prepare();
  await seed();
}

async function resetData() {
  await db.testing.reset();
  outbox.length = 0;
}

async function teardownDB() {
  await db.testing.dropDatabase();
  await db.disconnect();
}

const app = createApp();
const api = () => request(app);

// Artist selling NFTs for revenue, ready to go -> creator / high.
const ANSWERS_CREATOR_REVENUE = [
  { questionKey: 'role', optionKey: 'artist' },
  { questionKey: 'goal', optionKeys: ['sell_nfts'] },
  { questionKey: 'outcome', optionKey: 'revenue' },
  { questionKey: 'timeline', optionKey: '1_3_months' },
  { questionKey: 'resources', optionKeys: ['portfolio', 'audience'] },
  { questionKey: 'engagement', optionKey: 'guided' },
  { questionKey: 'risk', optionKey: 'balanced' },
  { questionKey: 'project', optionKey: 'yes' },
];

async function submitQuestionnaire(answers = ANSWERS_CREATOR_REVENUE) {
  const res = await api().post('/api/v1/onboarding/questionnaire/submit').send({ version: 4, answers });
  return res.body.data.submissionId;
}

const PASSWORD = 'Papolona123';

// A different Icelandic number each call: every account needs a unique mobile number.
let phoneSeq = 0;
const nextPhone = () => `+354${String(6000000 + (phoneSeq += 1))}`;

async function registerUser(overrides = {}) {
  const submissionId = await submitQuestionnaire();
  const res = await api()
    .post('/api/v1/auth/register')
    .send({
      name: 'Asha Verma',
      email: `user${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`,
      password: PASSWORD,
      phone: nextPhone(),
      questionnaireSubmissionId: submissionId,
      ...overrides,
    });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { ...res.body.data, password: PASSWORD, submissionId };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

/** Extracts the 6-digit code from the latest reset email sent to `email`. */
function lastResetCode(email) {
  const mail = [...outbox].reverse().find((m) => m.to === email && /reset code/i.test(m.subject));
  return mail?.text.match(/\b(\d{6})\b/)?.[1];
}

/** Extracts the 6-digit code from the latest email/phone/password change confirmation sent to `email`. */
function lastChangeCode(email) {
  const mail = [...outbox].reverse().find((m) => m.to === email && /confirmation code/i.test(m.subject));
  return mail?.text.match(/\b(\d{6})\b/)?.[1];
}

module.exports = {
  setupDB,
  resetData,
  teardownDB,
  api,
  submitQuestionnaire,
  registerUser,
  bearer,
  lastResetCode,
  lastChangeCode,
  nextPhone,
  outbox,
  PASSWORD,
  ANSWERS_CREATOR_REVENUE,
};
