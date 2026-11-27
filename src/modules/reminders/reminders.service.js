const env = require('../../config/env');
const db = require('../../db');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { sendMail } = require('../../utils/mailer');
const { localDateTime, nextOccurrence } = require('../../utils/zonedTime');

/**
 * The user's reminders from the Journal, and the dispatcher that emails them when due. The dispatcher
 * runs every minute on an always-on server (src/server.js) and from a scheduler calling the cron route
 * on Vercel. Each reminder is claimed in the database before its email goes out, so overlapping runs
 * never send twice.
 */

const MAX_REMINDERS = 50;
// A little slack for a slow phone clock or a slow request when "now" is picked.
const PAST_SLACK_MS = 2 * 60 * 1000;
const BATCH = 200;

const inPast = (date, now) => date.getTime() < now.getTime() - PAST_SLACK_MS;
const REMINDER_IN_PAST = () => ApiError.badRequest('REMINDER_IN_PAST', 'Pick a time in the future.');

function list(userId) {
  return db.reminders.list(userId);
}

async function create(userId, { title, note = '', remindAt, repeat, timeZone }, now = new Date()) {
  if (inPast(remindAt, now)) throw REMINDER_IN_PAST();
  if ((await db.reminders.countForUser(userId)) >= MAX_REMINDERS) {
    throw ApiError.conflict('TOO_MANY_REMINDERS', `You can keep up to ${MAX_REMINDERS} reminders. Delete some first.`);
  }
  return db.reminders.create(userId, { title, note, startsAt: remindAt, remindAt, repeat, timeZone });
}

/** Edits a reminder. A new time restarts its schedule; turning a past one-off back on needs a new time. */
async function update(userId, id, changes, now = new Date()) {
  const current = await db.reminders.find(userId, id);
  if (!current) throw ApiError.notFound('REMINDER_NOT_FOUND', 'Reminder not found.');

  const next = { ...changes };
  const repeat = changes.repeat ?? current.repeat;
  const timeZone = changes.timeZone ?? current.timeZone;
  const active = changes.active ?? current.active;

  if (changes.remindAt) {
    if (inPast(changes.remindAt, now)) throw REMINDER_IN_PAST();
    next.startsAt = changes.remindAt;
    if (changes.active === undefined) next.active = true;
  } else if (active && inPast(current.remindAt, now)) {
    // Resumed (or kept on) after its time passed: a repeat moves to its next time; a one-off needs a new one.
    const upcoming = nextOccurrence(current.startsAt, repeat, timeZone, now);
    if (!upcoming) throw REMINDER_IN_PAST();
    next.remindAt = upcoming;
  } else if (changes.repeat || changes.timeZone) {
    next.startsAt = current.remindAt;
  }
  return db.reminders.update(userId, id, next);
}

async function remove(userId, id) {
  if (!(await db.reminders.remove(userId, id))) throw ApiError.notFound('REMINDER_NOT_FOUND', 'Reminder not found.');
}

const REPEAT_WORDS = { daily: 'every day', weekly: 'every week', monthly: 'every month' };

/** "Fri, 6 Nov 2026, 09:30" in the reminder's own time zone. */
const formatWhen = (date, timeZone) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(date);

function reminderMail({ name, title, note, remindAt, repeat, timeZone }) {
  const lines = [
    `Hello ${name || 'there'},`,
    '',
    `This is your Papolona reminder: ${title}`,
    ...(note ? ['', note] : []),
    '',
    `Set for ${formatWhen(remindAt, timeZone)} (${timeZone})${repeat !== 'none' ? `, repeating ${REPEAT_WORDS[repeat]}` : ''}.`,
    '',
    'You can change or delete it in the Papolona app: Profile > Reminders.',
  ];
  return { subject: `Reminder: ${title}`, text: lines.join('\n') };
}

function readingMail({ name }) {
  return {
    subject: 'Your Papolona reading is waiting',
    text: [
      `Hello ${name || 'there'},`,
      '',
      'Your clue for today is ready to be drawn. Ask your question in the Journal, draw the clue and interpret it.',
      '',
      'You get this daily reminder because reading reminders are on. You can change its time or turn it off in the app: Profile > Settings.',
    ].join('\n'),
  };
}

/** Emails every due reminder once, then moves repeating ones to their next time. */
async function dispatchCustom(now) {
  const result = { sent: 0, failed: 0 };
  const due = await db.reminders.due(now, BATCH);
  for (const reminder of due) {
    const nextAt = nextOccurrence(reminder.startsAt, reminder.repeat, reminder.timeZone, now);
    if (!(await db.reminders.claim(reminder.id, reminder.remindAt, nextAt, now))) continue;
    try {
      await sendMail({ to: reminder.email, ...reminderMail(reminder) });
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      logger.error(`Reminder ${reminder.id} email failed`, err.message);
    }
  }
  return result;
}

/**
 * The daily reading reminder: once a day, at or after the user's reminder time in their own time zone,
 * while today's clue can be drawn and has not been drawn yet.
 */
async function dispatchReadings(now) {
  const result = { sent: 0, failed: 0 };
  const candidates = await db.readingReminders.candidates();
  for (const user of candidates) {
    let local;
    try {
      local = localDateTime(now, user.timeZone);
    } catch {
      continue; // a time zone Intl no longer knows
    }
    if (user.sentOn === local.date || local.time < user.reminderTime) continue;

    const latest = await db.clueDraws.latestForUser(user.id);
    if (latest && localDateTime(latest.generatedAt, user.timeZone).date === local.date) continue;

    if (!(await db.readingReminders.claim(user.id, local.date))) continue;
    try {
      await sendMail({ to: user.email, ...readingMail(user) });
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      logger.error(`Reading reminder for ${user.id} failed`, err.message);
    }
  }
  return result;
}

// How long before an active member's window closes they are reminded to convert another NFT.
const ACTIVE_NUDGE_MS = 7 * 24 * 60 * 60 * 1000;

function activeMail({ name, activeUntil }) {
  const until = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(activeUntil);
  return {
    subject: 'Convert an NFT to stay an active member',
    text: [
      `Hello ${name || 'there'},`,
      '',
      `Your active membership runs until ${until}. Convert one of your emblems into an NFT before then to stay active: open the Papolona app, then Gallery, choose an emblem and convert it.`,
      '',
      'You get this email because series deadline emails are on. You can turn them off in the app: Profile > Notifications.',
    ].join('\n'),
  };
}

/** Emails each active member once per window, a week before it closes, to convert another NFT. */
async function dispatchActive(now) {
  const result = { sent: 0, failed: 0 };
  const windowMs = env.ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const due = await db.market.activeReminderCandidates(now, new Date(now.getTime() + ACTIVE_NUDGE_MS), windowMs);
  for (const user of due) {
    await db.market.markActiveReminder(user.id, user.activeUntil);
    try {
      await sendMail({ to: user.email, ...activeMail(user) });
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      logger.error(`Active membership reminder for ${user.id} failed`, err.message);
    }
  }
  return result;
}

const HOUR_MS = 60 * 60 * 1000;
// Matches clue.service: a reading is judged at most this many times.
const MAX_READING_ATTEMPTS = 3;

function lastHourMail({ name, clue }) {
  return {
    subject: `Less than an hour left for your reading ${clue}`,
    text: [
      `Hello ${name || 'there'},`,
      '',
      `Your reading ${clue} has less than an hour left. Complete it in the Journal before its ${env.READING_WINDOW_HOURS} hours are up, or it fails (and so does the series it belongs to).`,
      '',
      'You get this email because series deadline emails are on. You can turn them off in the app: Profile > Notifications.',
    ].join('\n'),
  };
}

/** Emails each reading once as it enters the last hour of its window, while it can still be completed. */
async function dispatchLastHour(now) {
  const result = { sent: 0, failed: 0 };
  const windowMs = env.READING_WINDOW_HOURS * HOUR_MS;
  // Drawn between window and window-minus-an-hour ago: the last hour has started, the time is not up.
  const from = new Date(now.getTime() - windowMs);
  const to = new Date(now.getTime() - windowMs + HOUR_MS);
  const due = await db.clueDraws.lastHourCandidates(from, to, MAX_READING_ATTEMPTS, BATCH);
  for (const reading of due) {
    if (!(await db.clueDraws.claimDeadlineWarning(reading.id, now))) continue;
    try {
      await sendMail({ to: reading.email, ...lastHourMail(reading) });
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      logger.error(`Last-hour warning for reading ${reading.id} failed`, err.message);
    }
  }
  return result;
}

function collectorMail({ name }) {
  return {
    subject: 'You can start creating too',
    text: [
      `Hello ${name || 'there'},`,
      '',
      'As a Collector you support the members who create. You can create too: switch to Creator in the Papolona app (Profile > Membership). You start as a provisional Creator with Single, Twin and Level 1 readings, and your first Level 1 series converted into an NFT makes you a full Creator.',
      '',
      'You get this email because product updates are on. You can turn them off in the app: Profile > Notifications.',
    ].join('\n'),
  };
}

/** Every COLLECTOR_NUDGE_DAYS, reminds each Collector (a Collector that long) that they can start creating. */
async function dispatchCollectors(now) {
  const result = { sent: 0, failed: 0 };
  const since = new Date(now.getTime() - env.COLLECTOR_NUDGE_DAYS * 24 * 60 * 60 * 1000);
  const due = await db.users.collectorNudgeCandidates(since, BATCH);
  for (const user of due) {
    if (!(await db.users.claimCollectorNudge(user.id, since, now))) continue;
    try {
      await sendMail({ to: user.email, ...collectorMail(user) });
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      logger.error(`Collector reminder for ${user.id} failed`, err.message);
    }
  }
  return result;
}

async function dispatchDue(now = new Date()) {
  const reminders = await dispatchCustom(now);
  const readings = await dispatchReadings(now);
  const active = await dispatchActive(now);
  const lastHour = await dispatchLastHour(now);
  const collectors = await dispatchCollectors(now);
  // Collectors' auctions that have closed: each NFT goes to its highest bidder. Required here, not at the
  // top, to keep the market's dependencies out of the reminders module's load order.
  const auctions = await require('../market/market.service').settleDueAuctions(now);
  const total = [reminders, readings, active, lastHour, collectors].reduce((n, r) => n + r.sent + r.failed, 0);
  if (total > 0) {
    logger.info(
      `Reminders: ${reminders.sent} sent, ${reminders.failed} failed; reading reminders: ${readings.sent} sent, ${readings.failed} failed; active membership: ${active.sent} sent, ${active.failed} failed; last hour: ${lastHour.sent} sent, ${lastHour.failed} failed; collectors: ${collectors.sent} sent, ${collectors.failed} failed`,
    );
  }
  return { reminders, readings, active, lastHour, collectors, auctions };
}

module.exports = { list, create, update, remove, dispatchDue, MAX_REMINDERS };
