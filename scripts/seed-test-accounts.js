/**
 * Development testing only: creates two accounts in the database in DATABASE_URL, through the app's
 * own sign-up (questionnaire, then register), so you can test the flows after onboarding:
 *
 *   Fresh account (just signed up: probation, no readings)
 *     name "Fia Fresh"   email fresh@papolona.test   password Fresh12345
 *
 *   Ready account (probation complete, not a member yet: can pay the membership fee)
 *     name "Rey Ready"   email ready@papolona.test   password Ready12345
 *
 *   npm run seed:test-accounts      (or: node scripts/seed-test-accounts.js)
 *
 * Re-running deletes and recreates both accounts, so they start over each time. The ready account
 * gets PROBATION_READINGS passed readings, one a day ending two days ago, so it can draw today's clue.
 * No email is sent (the mail provider is switched off for this script). Refuses to run in production.
 */

// Before env loads: dotenv keeps values already set, so this switches mail off for the script only.
process.env.SMTP_HOST = '';
process.env.BREVO_API_KEY = '';

const request = require('supertest');
const env = require('../src/config/env');
const db = require('../src/db');
const { createApp } = require('../src/app');

const ACCOUNTS = {
  // Sign-up needs a mobile number; these are made-up Indian numbers.
  fresh: { name: 'Fia Fresh', email: 'fresh@papolona.test', password: 'Fresh12345', phone: '+919000000001' },
  ready: { name: 'Rey Ready', email: 'ready@papolona.test', password: 'Ready12345', phone: '+919000000002' },
};

const DAY = 24 * 60 * 60 * 1000;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const clue = () => Array.from({ length: 6 }, () => LETTERS[Math.floor(Math.random() * 26)]).join('');
const between = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

const ANSWERS = [
  { questionKey: 'role', optionKey: 'artist' },
  { questionKey: 'goal', optionKeys: ['sell_nfts'] },
  { questionKey: 'outcome', optionKey: 'revenue' },
  { questionKey: 'timeline', optionKey: '1_3_months' },
  { questionKey: 'resources', optionKeys: ['portfolio', 'audience'] },
  { questionKey: 'engagement', optionKey: 'guided' },
  { questionKey: 'risk', optionKey: 'balanced' },
  { questionKey: 'project', optionKey: 'yes' },
];

async function createAccount(app, { name, email, password, phone }) {
  const existing = await db.users.findByEmail(email);
  if (existing) await db.users.remove(existing.id);

  const questionnaire = await request(app).get('/api/v1/onboarding/questionnaire');
  const version = questionnaire.body?.data?.version ?? 3;
  const submission = await request(app).post('/api/v1/onboarding/questionnaire/submit').send({ version, answers: ANSWERS });
  if (submission.status >= 300) throw new Error(`questionnaire failed: ${JSON.stringify(submission.body)}`);

  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ name, email, password, phone, questionnaireSubmissionId: submission.body.data.submissionId });
  if (res.status !== 201) throw new Error(`register failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.data.user.id;
}

/** Passed readings, one a day, the newest two days ago (so the 24-hour clue limit has passed). */
async function completeProbation(userId) {
  const now = Date.now();
  for (let i = env.PROBATION_READINGS + 1; i >= 2; i -= 1) {
    const at = new Date(now - i * DAY);
    const draw = await db.clueDraws.create({
      userId,
      clue: clue(),
      question: 'What guidance do I need for today?',
      generatedAt: at,
      nextAvailableAt: new Date(at.getTime() + DAY),
    });
    const eeriness = between(5, 9);
    const satisfaction = between(5, 10);
    await db.clueDraws.saveJudgement(userId, draw.id, {
      text: `${draw.clue.slice(0, 3)}-${draw.clue.slice(3)}: a beginning, then a return. Together: start again, gently.`,
      source: 'text',
      verdict: 'pass',
      parts: [
        { part: draw.clue.slice(0, 3), meaning: 'a beginning' },
        { part: draw.clue.slice(3), meaning: 'a return' },
      ],
      feedback: 'You split the clue into clear parts and joined them into one message about your question.',
      eeriness,
      satisfaction,
      model: 'test-account-seed',
      judgedAt: new Date(at.getTime() + 20 * 60 * 1000),
    });
  }
}

async function main() {
  if (env.NODE_ENV === 'production') throw new Error('Refusing to create test accounts in production.');
  await db.connect(env.DATABASE_URL);
  const app = createApp();

  await createAccount(app, ACCOUNTS.fresh);
  const readyId = await createAccount(app, ACCOUNTS.ready);
  await completeProbation(readyId);

  const ready = await db.users.findById(readyId);
  const passed = await db.clueDraws.countPassed(readyId);
  console.log(`Created ${ACCOUNTS.fresh.email} (new) and ${ACCOUNTS.ready.email} (${passed} passed readings, status ${ready.status}).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.disconnect());
