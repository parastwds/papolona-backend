const { and, desc, eq, gt, isNull, sql } = require('drizzle-orm');
const { db } = require('./connection');
const { passwordResets: R, pendingChanges: P } = require('./schema');

/**
 * Emailed 6-digit codes: password resets, and pending email / phone / password changes.
 * One factory builds both repositories; `scope(table, ...)` is the extra filter for pending changes (type).
 */
function codeRepository(T, toCode) {
  const newest = async (where) => {
    const [row] = await db().select().from(T).where(where).orderBy(desc(T.createdAt)).limit(1);
    return toCode(row);
  };

  return {
    async create(values) {
      const [row] = await db().insert(T).values(values).returning();
      return toCode(row);
    },

    /** The newest code sent since `since` that has not been used (resend cooldown). */
    findRecent: (userId, scope, since) => newest(and(eq(T.userId, userId), scope, isNull(T.usedAt), gt(T.createdAt, since))),

    /** The newest code that can still be entered. */
    findActive: (userId, scope, now = new Date()) =>
      newest(and(eq(T.userId, userId), scope, isNull(T.usedAt), isNull(T.invalidatedAt), gt(T.expiresAt, now))),

    async invalidateActive(userId, scope, now = new Date()) {
      await db()
        .update(T)
        .set({ invalidatedAt: now, updatedAt: now })
        .where(and(eq(T.userId, userId), scope, isNull(T.usedAt), isNull(T.invalidatedAt)));
    },

    async invalidate(id, now = new Date()) {
      await db().update(T).set({ invalidatedAt: now, updatedAt: now }).where(eq(T.id, id));
    },

    /** Counts a wrong guess and returns the new attempt count. */
    async addAttempt(id) {
      const [row] = await db()
        .update(T)
        .set({ attempts: sql`${T.attempts} + 1`, updatedAt: new Date() })
        .where(eq(T.id, id))
        .returning({ attempts: T.attempts });
      return row.attempts;
    },

    /** Marks the code used. False if it was used or cancelled meanwhile, so a code works only once. */
    async consume(id, now = new Date()) {
      const rows = await db()
        .update(T)
        .set({ usedAt: now, updatedAt: now })
        .where(and(eq(T.id, id), isNull(T.usedAt), isNull(T.invalidatedAt)))
        .returning({ id: T.id });
      return rows.length > 0;
    },
  };
}

const baseCode = (row) => row && { id: row.id, userId: row.userId, codeHash: row.codeHash, attempts: row.attempts, createdAt: row.createdAt };

const resets = codeRepository(R, baseCode);
const changes = codeRepository(P, (row) => row && { ...baseCode(row), type: row.type, value: row.value });
const ofType = (type) => eq(P.type, type);

const passwordResets = {
  create: resets.create,
  findRecent: (userId, since) => resets.findRecent(userId, undefined, since),
  findActive: (userId, now) => resets.findActive(userId, undefined, now),
  invalidateActive: (userId, now) => resets.invalidateActive(userId, undefined, now),
  invalidate: resets.invalidate,
  addAttempt: resets.addAttempt,
  consume: resets.consume,
};

const pendingChanges = {
  create: changes.create,
  findRecent: (userId, type, since) => changes.findRecent(userId, ofType(type), since),
  findActive: (userId, type, now) => changes.findActive(userId, ofType(type), now),
  invalidateActive: (userId, type, now) => changes.invalidateActive(userId, ofType(type), now),
  invalidate: changes.invalidate,
  addAttempt: changes.addAttempt,
  consume: changes.consume,
};

module.exports = { passwordResets, pendingChanges };
