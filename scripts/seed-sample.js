/**
 * Local testing only: creates a sample account with about 14 months of history (readings with
 * verdicts and ratings, notes, reminders), so Home stats, the calendar zooms and My details have
 * something to show. Refuses to run against anything but a local PGlite database.
 *
 *   DATABASE_URL=pglite://.local-db node scripts/seed-sample.js
 *
 * Sign in to the app with SAMPLE_EMAIL / SAMPLE_PASSWORD below.
 *
 * A second, empty account is made through the app's own sign-up while testing onboarding:
 * name "Nova Tester", email nova@papolona.test, password Nova12345 (local database only).
 */
const { sql } = require('drizzle-orm');
const request = require('supertest');
const env = require('../src/config/env');
const db = require('../src/db');
const { db: drizzle } = require('../src/db/postgres/connection');
const { createApp } = require('../src/app');
const { seed } = require('../src/seed/seed');

const SAMPLE_EMAIL = 'sample@papolona.test';
const SAMPLE_PASSWORD = 'Sample1234';
const SAMPLE_NAME = 'Sam Sample';
const TIME_ZONE = 'Asia/Kolkata';

const DAY = 24 * 60 * 60 * 1000;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Deterministic randomness, so every run makes the same history.
let state = 20261106;
const rand = () => {
  state = (state * 1664525 + 1013904223) % 4294967296;
  return state / 4294967296;
};
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const clue = () => Array.from({ length: 6 }, () => pick(LETTERS)).join('');

const QUESTIONS = [
  'What should I focus on this week?',
  'Is it time to start the new painting?',
  'What is the meaning of the moth at my window?',
  'How do I mend things with my sister?',
  'Should I accept the gallery offer?',
  'What am I not seeing about my work?',
  'Thought for today',
  'Where is my creative energy going?',
];
const NOTES = [
  'Saw a black butterfly on the balcony this morning. It stayed for a long time.',
  'Dreamt of a staircase made of glass. Woke up calm.',
  'The clue felt uncannily close to what happened at lunch.',
  'Tired today. Short walk by the river; the light on the water was strange and beautiful.',
  'Sketched for two hours. The moth shape keeps coming back.',
  'Talked with Mira about the exhibition. She used the exact word from yesterday’s clue.',
  'Nothing special, but I felt watched by the trees in the park.',
  'Read about Orch OR again. Microtubules as tiny instruments.',
];
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

async function createAccount(app) {
  const existing = await db.users.findByEmail(SAMPLE_EMAIL);
  if (existing) await db.users.remove(existing.id);
  const submission = await request(app).post('/api/v1/onboarding/questionnaire/submit').send({ version: 4, answers: ANSWERS });
  const res = await request(app).post('/api/v1/auth/register').send({
    name: SAMPLE_NAME,
    email: SAMPLE_EMAIL,
    password: SAMPLE_PASSWORD,
    phone: '+919000000003', // made up; sign-up needs a mobile number
    questionnaireSubmissionId: submission.body.data.submissionId,
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  const user = res.body.data.user;
  await db.users.update(user.id, {
    profile: { timezone: TIME_ZONE, country: 'IN', bio: 'Painter of moths and night gardens. Testing Papolona.' },
  });
  return user.id;
}

// Notes are sealed with the latest clue drawn before them, as the app does; otherwise the next
// real draw would seal the whole sample history.
async function addNote(userId, at, text, clueDrawId) {
  await db.journal.create({
    userId,
    text,
    source: rand() < 0.2 ? 'voice' : 'text',
    clientId: `sample-${at.getTime()}-${rand()}`,
    clueDrawId,
  });
  await drizzle().execute(
    sql`update journal_entries set created_at = ${at.toISOString()}::timestamptz
        where id = (select id from journal_entries where user_id = ${userId} order by id desc limit 1)`,
  );
}

async function addReading(userId, at) {
  const draw = await db.clueDraws.create({
    userId,
    clue: clue(),
    question: pick(QUESTIONS),
    generatedAt: at,
    nextAvailableAt: new Date(at.getTime() + DAY),
  });
  const roll = rand();
  if (roll < 0.12) return { verdict: 'open', id: draw.id }; // never interpreted
  const verdict = roll < 0.8 ? 'pass' : 'fail';
  const aiEeriness = verdict === 'pass' ? between(5, 9) : between(1, 4);
  const aiSatisfaction = verdict === 'pass' ? between(5, 10) : between(1, 4);
  await db.clueDraws.saveJudgement(userId, draw.id, {
    text: `${draw.clue.slice(0, 3)}-${draw.clue.slice(3)}: the first part points to a beginning, the second to a return. Together: start again, gently.`,
    source: rand() < 0.3 ? 'voice' : 'text',
    verdict,
    parts: [
      { part: draw.clue.slice(0, 3), meaning: 'a beginning' },
      { part: draw.clue.slice(3), meaning: 'a return' },
    ],
    feedback:
      verdict === 'pass'
        ? 'You split the clue into clear parts and joined them into one message about your question.'
        : 'The parts were named but never combined into a message that answers your question.',
    eeriness: aiEeriness,
    satisfaction: aiSatisfaction,
    model: 'sample-data',
    judgedAt: new Date(at.getTime() + 20 * 60 * 1000),
  });
  if (rand() < 0.75) {
    await db.clueDraws.saveUserRating(userId, draw.id, {
      eeriness: Math.min(10, Math.max(1, aiEeriness + between(-2, 2))),
      satisfaction: Math.min(10, Math.max(1, aiSatisfaction + between(-2, 2))),
      ratedAt: new Date(at.getTime() + 30 * 60 * 1000),
    });
  }
  return { verdict, id: draw.id };
}

async function addHistory(userId) {
  const now = Date.now();
  let readings = 0;
  let passed = 0;
  let notes = 0;
  let lastDrawId = null;
  // Day 1 is yesterday (more than 24 h ago, so today's clue can be drawn); busier recently.
  for (let daysAgo = 430; daysAgo >= 1; daysAgo -= 1) {
    const chance = daysAgo <= 30 ? 0.85 : daysAgo <= 120 ? 0.5 : 0.22;
    const dayStart = now - daysAgo * DAY;
    if (rand() < chance) {
      // Mornings to evenings, India time; yesterday's reading is early enough to be over 24 h old.
      const at = new Date(dayStart - (daysAgo === 1 ? 3 : between(0, 8)) * 60 * 60 * 1000);
      const { verdict, id } = await addReading(userId, at);
      lastDrawId = id;
      readings += 1;
      if (verdict === 'pass') passed += 1;
    }
    const noteCount = rand() < chance ? between(1, 3) : 0;
    for (let i = 0; i < noteCount; i += 1) {
      await addNote(userId, new Date(dayStart + between(1, 10) * 60 * 60 * 1000), pick(NOTES), lastDrawId);
      notes += 1;
    }
  }
  return { readings, passed, notes };
}

async function addReminders(userId) {
  const tomorrowNine = new Date();
  tomorrowNine.setUTCDate(tomorrowNine.getUTCDate() + 1);
  tomorrowNine.setUTCHours(3, 30, 0, 0); // 09:00 India
  const inTwoMinutes = new Date(Math.ceil((Date.now() + 2 * 60 * 1000) / 60000) * 60000);
  const sentAt = new Date(Date.now() - 3 * DAY);
  await db.reminders.create(userId, {
    title: 'Visit the moth exhibition',
    note: 'Bring the sketchbook.',
    startsAt: tomorrowNine,
    remindAt: tomorrowNine,
    repeat: 'none',
    timeZone: TIME_ZONE,
  });
  await db.reminders.create(userId, {
    title: 'Evening reflection',
    note: 'Write three lines about the day.',
    startsAt: inTwoMinutes,
    remindAt: inTwoMinutes,
    repeat: 'daily',
    timeZone: TIME_ZONE,
  });
  const sent = await db.reminders.create(userId, {
    title: 'Call the framer',
    note: '',
    startsAt: sentAt,
    remindAt: sentAt,
    repeat: 'none',
    timeZone: TIME_ZONE,
  });
  await db.reminders.update(userId, sent.id, { active: false, lastSentAt: sentAt });
}

async function main() {
  if (!env.DATABASE_URL.startsWith('pglite://')) {
    throw new Error('seed-sample only runs against a local pglite:// database.');
  }
  await db.connect(env.DATABASE_URL);
  await seed();
  const app = createApp();
  const userId = await createAccount(app);
  const history = await addHistory(userId);
  await addReminders(userId);
  console.log(
    `Sample account ${SAMPLE_EMAIL}: ${history.readings} readings (${history.passed} passed), ${history.notes} notes, 3 reminders.`,
  );
  await db.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.disconnect().catch(() => {});
  process.exit(1);
});
