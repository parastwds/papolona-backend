const crypto = require('crypto');
const { and, count, desc, eq, sql } = require('drizzle-orm');
const env = require('../../config/env');
const { db } = require('./connection');
const { users, journalEntries, passwordResets, pendingChanges, clueDraws, nftSeries } = require('./schema');

// Everything a test creates; the seeded questionnaire and app config are kept.
const USER_DATA = [
  'nft_listings',
  'stone_orders',
  'billing_profiles',
  'retreat_applications',
  'payments',
  'reminders',
  'journal_insights',
  'journal_entries',
  'clue_draws',
  'nft_series',
  'legal_acceptances',
  'pending_changes',
  'password_resets',
  'sessions',
  'user_identities',
  'questionnaire_submissions',
  'users',
];

function assertTest() {
  if (env.NODE_ENV !== 'test') throw new Error('db.testing is only available when NODE_ENV=test.');
}

/** Test-only helpers for state the API cannot reach. Both drivers implement the same functions. */
module.exports = {
  /** Nothing to do: migrations (tables, unique indexes) are applied when the test database is created. */
  async prepare() {
    assertTest();
  },

  async reset() {
    assertTest();
    await db().execute(sql.raw(`truncate ${USER_DATA.join(', ')} cascade`));
  },

  /** The in-memory database disappears when it is closed. */
  async dropDatabase() {
    assertTest();
  },

  /** A syntactically valid id that matches nothing. */
  unknownId: () => crypto.randomUUID(),

  countUsers: async () => (await db().select({ n: count() }).from(users))[0].n,
  countJournalEntries: async () => (await db().select({ n: count() }).from(journalEntries))[0].n,

  /** Moves every password reset code back in time (to skip the resend cooldown). */
  async backdatePasswordResets(ms) {
    assertTest();
    await db().update(passwordResets).set({ createdAt: new Date(Date.now() - ms) });
  },

  /** Moves the user's sign-up back by `days`, as if they had joined earlier (the apprenticeship's days). */
  async backdateUser(userId, days) {
    assertTest();
    await db()
      .update(users)
      .set({ createdAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) })
      .where(eq(users.id, userId));
  },

  /** Gives the user `n` readings the judge passed, without drawing or judging (e.g. to finish probation). */
  async addPassedReadings(userId, n) {
    assertTest();
    const now = new Date();
    await db()
      .insert(clueDraws)
      .values(
        Array.from({ length: n }, () => ({
          userId,
          clue: 'ABCDEF',
          generatedAt: now,
          nextAvailableAt: now,
          interpretation: 'AB-CDEF',
          interpretationSource: 'text',
          verdict: 'pass',
          judgedAt: now,
        })),
      );
  },

  /** Moves all the user's clue draws back in time by `ms`, as if they had been drawn earlier. */
  async backdateDraws(userId, ms) {
    assertTest();
    await db().execute(
      sql`update clue_draws set generated_at = generated_at - (${ms} * interval '1 millisecond') where user_id = ${userId}`,
    );
  },

  async latestPendingChange(userId, type) {
    const [row] = await db()
      .select({ type: pendingChanges.type, value: pendingChanges.value })
      .from(pendingChanges)
      .where(and(eq(pendingChanges.userId, userId), eq(pendingChanges.type, type)))
      .orderBy(desc(pendingChanges.createdAt))
      .limit(1);
    return row ?? null;
  },
};
