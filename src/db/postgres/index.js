const { sql } = require('drizzle-orm');
const logger = require('../../utils/logger');
const connection = require('./connection');
const { isValidId, isInvalidIdError } = require('./shared');
const users = require('./users');
const sessions = require('./sessions');
const { passwordResets, pendingChanges } = require('./codes');
const { questionnaires, submissions } = require('./onboarding');
const { appConfig, legalAcceptances } = require('./config');
const { clueDraws, journal, journalInsights } = require('./journal');
const { stats } = require('./stats');
const { reminders, readingReminderCandidates, claimReadingReminder } = require('./reminders');
const { payments } = require('./payments');
const { series } = require('./series');
const { badges } = require('./badges');
const { community } = require('./community');
const { market } = require('./market');
const { billing } = require('./billing');
const { retreat } = require('./retreat');
const { dms } = require('./dms');
const { members } = require('./members');
const testing = require('./testing');

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** Long-running server and scripts: connect once. Tables come from `npm run db:migrate`, not from here. */
async function connect(url) {
  await connection.ensure(url);
  logger.info(`PostgreSQL connected: ${hostOf(url)}`);
}

/** Serverless (Vercel): one pool per warm function instance, shared by all its requests. */
const ensureConnected = (url) => connection.ensure(url);

const disconnect = () => connection.close();

/** Health check: true when a query round-trips. */
async function ping() {
  if (!connection.isConnected()) return false;
  try {
    await connection.db().execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  driver: 'postgres',
  connect,
  ensureConnected,
  disconnect,
  ping,
  isValidId,
  isInvalidIdError,
  migrate: connection.migrateServer,
  IN_MEMORY_URL: connection.IN_MEMORY_URL,
  users,
  sessions,
  passwordResets,
  pendingChanges,
  questionnaires,
  submissions,
  legalAcceptances,
  appConfig,
  clueDraws,
  journal,
  journalInsights,
  stats,
  reminders,
  readingReminders: { candidates: readingReminderCandidates, claim: claimReadingReminder },
  payments,
  series,
  badges,
  community,
  market,
  billing,
  retreat,
  dms,
  members,
  testing,
};
