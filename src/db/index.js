/**
 * The PostgreSQL repositories (Drizzle). Services only use what is exported here:
 *
 *   connect(url) / ensureConnected(url) / disconnect() / ping()
 *   isValidId(id), isInvalidIdError(err)
 *   users, sessions, passwordResets, pendingChanges, questionnaires, submissions,
 *   legalAcceptances, appConfig, clueDraws, journal, journalInsights
 *   testing (test-only helpers)
 */
module.exports = require('./postgres');
