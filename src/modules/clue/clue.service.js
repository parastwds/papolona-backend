const env = require('../../config/env');
const db = require('../../db');
const journal = require('../journal/journal.service');
const users = require('../users/users.service');
const series = require('../series/series.service');
const judgeAi = require('./judge.ai');
const promptAi = require('./prompt.ai');
const pennies = require('../pennies/pennies.service');
const { isTimeZone, partsInZone, zonedToUtc } = require('../../utils/zonedTime');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { sendMail } = require('../../utils/mailer');

const CLUE_LENGTH = 6;
// A random byte is an ASCII letter 52 times in 256 (~20%), so a 20-byte ANU response gives
// ~4 letters. Letters carry over between calls; 6 calls fail to reach 6 letters almost never.
const MAX_ATTEMPTS = 6;

const isAsciiLetter = (code) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/**
 * Reads the ANU hex strings as bytes (two hex digits each), in order: the first string,
 * then the next. Keeps the bytes that are ASCII letters (A–Z, a–z) and drops the rest.
 * Returns fewer than `length` letters if they run out.
 */
function extractLetters(hexStrings, length = CLUE_LENGTH) {
  let letters = '';
  for (const hex of hexStrings) {
    const pairs = String(hex).match(/[0-9a-f]{2}/gi) ?? [];
    for (const pair of pairs) {
      const code = parseInt(pair, 16);
      if (isAsciiLetter(code)) letters += String.fromCharCode(code);
      if (letters.length === length) return letters;
    }
  }
  return letters;
}

/** ANU Quantum Random Numbers call. Kept on an object so tests can replace it. */
const qrng = {
  async fetchHexStrings() {
    let response;
    try {
      response = await fetch(env.QRNG_API_URL, {
        headers: { 'X-API-Key': env.QRNG_API_KEY, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      logger.error('QRNG request failed', err);
      throw sourceUnavailable();
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.success || !Array.isArray(payload.data)) {
      logger.error(`QRNG responded ${response.status}`, payload);
      throw sourceUnavailable();
    }
    return payload.data;
  },
};

const sourceUnavailable = () =>
  new ApiError(502, 'CLUE_SOURCE_UNAVAILABLE', 'Could not reach the quantum number source. Please try again.');

async function drawLetters() {
  let letters = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    letters += extractLetters(await qrng.fetchHexStrings(), CLUE_LENGTH - letters.length);
    if (letters.length === CLUE_LENGTH) return letters.toUpperCase();
  }
  throw sourceUnavailable();
}

const HISTORY_PAGE_SIZE = 20;

// A reading's interpretation is judged at most this many times: a fail may be reviewed and resubmitted
// until then. Past that the reading is closed, and a member's series it belonged to has failed.
const MAX_READING_ATTEMPTS = 3;
// A reading must be completed (passed) within READING_WINDOW_HOURS of its draw, or it fails.
const windowMs = () => env.READING_WINDOW_HOURS * 60 * 60 * 1000;
const deadlineOf = (draw) => new Date(new Date(draw.generatedAt).getTime() + windowMs());
const passed = (draw) => draw.interpretation?.verdict === 'pass';
const isExpired = (draw, now = new Date()) => !passed(draw) && deadlineOf(draw) <= now;
const attemptsLeft = (draw, now = new Date()) =>
  passed(draw) || isExpired(draw, now) ? 0 : Math.max(0, MAX_READING_ATTEMPTS - (draw.attempts ?? 0));
const readingExpired = () =>
  ApiError.conflict(
    'READING_EXPIRED',
    `This reading was not completed within ${env.READING_WINDOW_HOURS} hours, so it has failed. Start a new reading.`,
  );

// The split options (a prompt) open this long after the clue is drawn, if the user has not interpreted it
// by then. On an object so tests can change it.
const PROMPT_TIMING = { delayMinutes: 5 };
const promptAvailableAt = (draw) => new Date(new Date(draw.generatedAt).getTime() + PROMPT_TIMING.delayMinutes * 60 * 1000);

const toPublicDraw = (draw) =>
  draw
    ? {
        id: draw.id,
        clue: draw.clue,
        question: draw.question,
        generatedAt: draw.generatedAt,
        interpretation: draw.interpretation ?? null,
        // Complete (pass) it by deadlineAt, or it fails (expired).
        deadlineAt: deadlineOf(draw),
        expired: isExpired(draw),
        // Judged attempts so far, and how many are left (0 once passed, out of attempts or expired).
        attempts: draw.attempts ?? 0,
        attemptsLeft: attemptsLeft(draw),
        maxAttempts: MAX_READING_ATTEMPTS,
        // When the split options open (PROMPT_TIMING after the draw).
        promptAvailableAt: promptAvailableAt(draw),
        ratings: draw.ratings ?? null,
        // The NFT series it was drawn in, and the tile its pass revealed.
        seriesId: draw.seriesId ?? null,
        tileIndex: draw.tileIndex ?? null,
        // The splits offered when the user tapped the clue for a prompt; null if they never did.
        prompt: draw.prompt ?? null,
        // The user's contest of a failed judgement ({ text, at }), and whether they may still send one.
        contest: draw.contest ?? null,
        canContest: canContest(draw),
      }
    : null;

/**
 * A reading may be contested once it has failed all MAX_READING_ATTEMPTS judgements, within
 * CONTEST_WINDOW_DAYS of its last judgement, and only once.
 */
function canContest(draw, now = new Date()) {
  const judged = draw.interpretation;
  if (!judged || judged.verdict !== 'fail' || draw.contest) return false;
  if ((draw.attempts ?? 0) < MAX_READING_ATTEMPTS) return false;
  const judgedAt = judged.judgedAt ? new Date(judged.judgedAt).getTime() : now.getTime();
  return now.getTime() - judgedAt <= env.CONTEST_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/** Who reads contests: CONTEST_EMAIL, else the SMTP account, else MAIL_FROM. */
function contestInbox() {
  if (env.CONTEST_EMAIL) return env.CONTEST_EMAIL;
  if (env.SMTP_USER && env.SMTP_USER.includes('@')) return env.SMTP_USER;
  const match = env.MAIL_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : env.MAIL_FROM).trim();
}

/** The email Papolona gets for a contest: who, the reading in full, the judge's verdict and the member's case. */
const contestMail = (user, draw, text) => ({
  subject: `Judgement contested: ${draw.clue} by ${user.name}`,
  text: [
    `${user.name} (${user.email}) contests the judgement on a reading that failed all ${MAX_READING_ATTEMPTS} attempts.`,
    '',
    `Question: ${draw.question || '(left blank)'}`,
    `Clue string: ${draw.clue}`,
    `Drawn: ${new Date(draw.generatedAt).toUTCString()}`,
    '',
    'Their last interpretation:',
    draw.interpretation?.text ?? '',
    '',
    "Papolona's judgement (not coherent):",
    draw.interpretation?.feedback ?? '',
    '',
    'Why they contest it:',
    text,
    '',
    `Reading id: ${draw.id}`,
    'Reply to this email to answer them.',
  ].join('\n'),
});

/**
 * The user contests the judgement on one of their readings that failed all its attempts: their case is
 * emailed to Papolona (CONTEST_EMAIL) with the reading in full. Once per reading, within
 * CONTEST_WINDOW_DAYS. Resolves to the reading.
 */
async function contest(user, drawId, { text }) {
  const draw = await db.clueDraws.findOwn(user.id, drawId);
  if (!draw) throw ApiError.notFound('READING_NOT_FOUND', 'Reading not found.');
  if (draw.contest) throw ApiError.conflict('ALREADY_CONTESTED', 'You have already contested this judgement.');
  if (!canContest(draw)) {
    throw ApiError.conflict(
      'CANNOT_CONTEST',
      `Only a reading that failed all ${MAX_READING_ATTEMPTS} attempts can be contested, within ${env.CONTEST_WINDOW_DAYS} days.`,
    );
  }
  const saved = await db.clueDraws.saveContest(user.id, drawId, {
    text,
    contestedAt: new Date(),
    minAttempts: MAX_READING_ATTEMPTS,
  });
  // A second tap got there first.
  if (!saved) throw ApiError.conflict('ALREADY_CONTESTED', 'You have already contested this judgement.');
  await sendMail({ to: contestInbox(), ...contestMail(user, saved, text) }).catch((err) =>
    logger.error(`Contest mail for reading ${drawId} failed`, err),
  );
  return toPublicDraw(saved);
}

// Prompts a month: generous while learning, fewer once the member is tuned in. Working without them is best.
const PROMPTS_PER_MONTH = { apprentice: 90, member: 30 };

/** The user's prompt month, from the 1st in their time zone (UTC without one): { from, to }. */
function promptMonth(user, now) {
  const zone = isTimeZone(user?.profile?.timezone) ? user.profile.timezone : 'UTC';
  const { year, month } = partsInZone(now, zone);
  return { from: zonedToUtc({ year, month, day: 1 }, zone), to: zonedToUtc({ year, month: month + 1, day: 1 }, zone) };
}

/** How many prompts the user has this month: { stage, limit, used, remaining, resetsAt }. */
async function getPromptAllowance(user, now = new Date()) {
  const stage = user?.status === 'member' ? 'member' : 'apprentice';
  const limit = PROMPTS_PER_MONTH[stage];
  const { from, to } = promptMonth(user, now);
  const used = user ? await db.clueDraws.countPromptsSince(user.id, from) : 0;
  return { stage, limit, used, remaining: Math.max(0, limit - used), resetsAt: to };
}

/**
 * The user's latest reading and whether they can draw a new clue: there is no limit on readings, but the
 * latest clue must be interpreted (and judged) first, unless its time ran out.
 */
async function getStatus(userId) {
  const now = new Date();
  const [user, draw] = await Promise.all([db.users.findById(userId), db.clueDraws.latestForUser(userId)]);
  return {
    canGenerate: !draw || Boolean(draw.interpretation) || isExpired(draw, now),
    lastClue: toPublicDraw(draw),
    prompts: await getPromptAllowance(user, now),
  };
}

/** The user's readings (question, clue and judged interpretation), newest first; pass nextCursor as `before`. */
async function listHistory(userId, { before, limit = HISTORY_PAGE_SIZE }) {
  const page = await db.clueDraws.list(userId, { before, limit });
  return { ...page, readings: page.readings.map(toPublicDraw) };
}

/**
 * The user's interpretation of their latest clue, judged by the AI. A pass is one more reading toward
 * graduation. A fail may be reviewed and resubmitted, up to MAX_READING_ATTEMPTS judgements in all, or left
 * for a new reading. Not after READING_WINDOW_HOURS from the draw (409 READING_EXPIRED): the reading has failed. When the last attempt fails the reading is closed: an apprentice starts a new reading,
 * and a member's series it was drawn in has failed. Nothing is saved (no attempt used) if the judge can't be
 * reached, so they can retry.
 */
async function interpret(userId, drawId, { text, source }) {
  const latest = await db.clueDraws.latestForUser(userId);
  if (!latest || latest.id !== drawId) {
    throw ApiError.conflict('READING_CLOSED', 'Only your latest clue can be interpreted.');
  }
  if (passed(latest)) {
    throw ApiError.conflict('ALREADY_JUDGED', 'This clue has already passed.');
  }
  if (isExpired(latest)) throw readingExpired();
  if (attemptsLeft(latest) <= 0) {
    throw ApiError.conflict('NO_ATTEMPTS_LEFT', `This reading has used all ${MAX_READING_ATTEMPTS} attempts. Start a new reading.`);
  }

  const { verdict, parts, feedback, eeriness, satisfaction, model } = await judgeAi.judge({
    question: latest.question,
    clue: latest.clue,
    interpretation: text,
  });
  const saved = await db.clueDraws.saveJudgement(userId, drawId, {
    attempt: (latest.attempts ?? 0) + 1,
    text,
    source,
    verdict,
    parts,
    feedback,
    eeriness,
    satisfaction,
    model,
    judgedAt: new Date(),
  });
  // Another request judged this attempt first.
  if (!saved) throw ApiError.conflict('ALREADY_JUDGED', 'This attempt has already been judged.');

  // A pass in an NFT series reveals its next tile; a member's last failed attempt fails the series.
  const user = await db.users.findById(userId);
  const { series: progress, tileIndex } = await series.onJudged(userId, saved, {
    outOfAttempts: attemptsLeft(saved) <= 0,
    member: user?.status === 'member',
  });
  return {
    reading: toPublicDraw({ ...saved, tileIndex: tileIndex ?? saved.tileIndex }),
    probation: await users.getProbation(user),
    series: progress,
  };
}

/**
 * A prompt: a few ways to split the clue, for the user to choose from. They open PROMPT_TIMING after the
 * draw (409 PROMPT_NOT_YET before that; the app opens them by itself then if nothing is written). One prompt
 * per clue, on the latest clue before it passes (a failed one may be prompted before it is resubmitted);
 * asking again shows the same choices without using another. Each new
 * prompt counts against the monthly allowance (409 NO_PROMPTS_LEFT once it is used up). Nothing is used if
 * the AI can't be reached. Returns { reading, prompts }.
 */
async function prompt(userId, drawId) {
  const latest = await db.clueDraws.latestForUser(userId);
  if (!latest || latest.id !== drawId) {
    throw ApiError.conflict('READING_CLOSED', 'Only your latest clue can be prompted.');
  }
  if (passed(latest)) {
    throw ApiError.conflict('ALREADY_JUDGED', 'This clue has already passed.');
  }
  if (isExpired(latest)) throw readingExpired();
  if (attemptsLeft(latest) <= 0) {
    throw ApiError.conflict('NO_ATTEMPTS_LEFT', `This reading has used all ${MAX_READING_ATTEMPTS} attempts.`);
  }
  const user = await db.users.findById(userId);
  if (latest.prompt) {
    return { reading: toPublicDraw(latest), prompts: await getPromptAllowance(user) };
  }

  const availableAt = promptAvailableAt(latest);
  if (availableAt > new Date()) {
    throw new ApiError(409, 'PROMPT_NOT_YET', 'The split options open five minutes after your clue is drawn. Try your own split first.', {
      promptAvailableAt: availableAt,
    });
  }

  const allowance = await getPromptAllowance(user);
  if (allowance.remaining <= 0) {
    throw new ApiError(
      409,
      'NO_PROMPTS_LEFT',
      `You have used all ${allowance.limit} prompts for this month. Trust your own split: that is the best way to learn.`,
      { prompts: allowance },
    );
  }

  // The suggestion costs a few pennies, given back when the AI can't be reached.
  const saved = await pennies.chargeFor(userId, env.PENNY_PROMPT_PRICE, 'clue_prompt', async () => {
    const { options, model } = await promptAi.suggest({ question: latest.question, clue: latest.clue });
    const result = await db.clueDraws.savePrompt(userId, drawId, { options, model, promptedAt: new Date() });
    // Another request prompted it first: this one is free.
    if (!result && env.PENNY_PROMPT_PRICE) await db.pennies.credit(userId, env.PENNY_PROMPT_PRICE, 'refund');
    return result;
  });
  // Another request prompted it first (or it passed meanwhile): show what is there now.
  const reading = saved ?? (await db.clueDraws.latestForUser(userId));
  if (!saved && reading?.interpretation?.verdict === 'pass') {
    throw ApiError.conflict('ALREADY_JUDGED', 'This clue has already passed.');
  }
  return { reading: toPublicDraw(reading), prompts: await getPromptAllowance(user) };
}

/**
 * A six-letter clue drawn from quantum random numbers for the user's question. No limit on readings, but no
 * skipping either: only the latest clue can be interpreted, so it must be interpreted (and judged) before
 * another is drawn. A failed reading with attempts left may be resubmitted, or left for a new one.
 */
async function generateClue(userId, { question }) {
  if (!env.QRNG_API_KEY) {
    throw new ApiError(503, 'CLUE_NOT_CONFIGURED', 'Clue generation is not available right now.');
  }

  const now = new Date();
  const latest = await db.clueDraws.latestForUser(userId);
  if (latest && !latest.interpretation && !isExpired(latest, now)) {
    throw new ApiError(409, 'INTERPRET_FIRST', 'Interpret your last clue before drawing a new one.', {
      lastClue: toPublicDraw(latest),
    });
  }
  // Each reading costs a few pennies, given back when the clue can't be drawn.
  const { draw, active } = await pennies.chargeFor(userId, env.PENNY_READING_PRICE, 'reading', async () => {
    const clue = await drawLetters();
    // A reading drawn during an NFT series belongs to it, and moves its deadline on.
    const current = await series.seriesForNewDraw(userId, now);
    const created = await db.clueDraws.createUnlessOpen({
      userId,
      clue,
      question,
      generatedAt: now,
      seriesId: current?.id ?? null,
      openSince: new Date(now.getTime() - windowMs()),
    });
    // Another request drew a clue first.
    if (!created) {
      throw new ApiError(409, 'INTERPRET_FIRST', 'Interpret your last clue before drawing a new one.', {
        lastClue: toPublicDraw(await db.clueDraws.latestForUser(userId)),
      });
    }
    return { draw: created, active: current };
  });
  // The journal entries written before this draw belong to it.
  await journal.sealOpenEntries(userId, draw.id);
  const progress = active ? await series.recordDraw(active.id, { at: now }) : null;
  return { ...toPublicDraw(draw), series: progress };
}

/** The user's own satisfaction (and optionally eeriness) rating, 1–10, of one of their readings; they may change it. */
async function rate(userId, drawId, { eeriness, satisfaction }) {
  const saved = await db.clueDraws.saveUserRating(userId, drawId, { eeriness, satisfaction, ratedAt: new Date() });
  if (!saved) throw ApiError.notFound('READING_NOT_FOUND', 'Reading not found.');
  return toPublicDraw(saved);
}

module.exports = {
  rate,
  contest,
  generateClue,
  getStatus,
  listHistory,
  interpret,
  prompt,
  getPromptAllowance,
  PROMPTS_PER_MONTH,
  MAX_READING_ATTEMPTS,
  PROMPT_TIMING,
  extractLetters,
  qrng,
  CLUE_LENGTH,
};
