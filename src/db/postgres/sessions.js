const { and, arrayContains, desc, eq, gt, gte, isNull, ne, sql } = require('drizzle-orm');
const { db } = require('./connection');
const { sessions: S } = require('./schema');

const HISTORY_LENGTH = 20; // previous refresh token hashes kept per session, for reuse detection

const toSession = (row) =>
  row && {
    id: row.id,
    userId: row.userId,
    family: row.family,
    platform: row.platform ?? null,
    appVersion: row.appVersion ?? null,
    userAgent: row.userAgent ?? null,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };

const revokeWhere = async (where, reason, now = new Date()) => {
  await db().update(S).set({ revokedAt: now, revokedReason: reason, updatedAt: now }).where(and(where, isNull(S.revokedAt)));
};

module.exports = {
  async create({ userId, family, tokenHash, expiresAt, ip, userAgent, platform, appVersion }) {
    const [row] = await db().insert(S).values({ userId, family, tokenHash, expiresAt, ip, userAgent, platform, appVersion }).returning();
    return toSession(row);
  },

  /** Whether the session exists for this user and has not been revoked (checked on every request). */
  async isActive(id, userId) {
    const rows = await db()
      .select({ id: S.id })
      .from(S)
      .where(and(eq(S.id, id), eq(S.userId, userId), isNull(S.revokedAt)))
      .limit(1);
    return rows.length > 0;
  },

  /**
   * Swaps a live refresh token for a new one in one statement; the old hash joins the history.
   * Returns the session, or null when the token is unknown, revoked or expired.
   */
  async rotate({ tokenHash, newTokenHash, now, expiresAt, ip }) {
    const [row] = await db()
      .update(S)
      .set({
        tokenHash: newTokenHash,
        lastUsedAt: now,
        expiresAt,
        ip,
        updatedAt: now,
        // Append, then keep only the last HISTORY_LENGTH hashes.
        previousTokenHashes: sql`(array_append(${S.previousTokenHashes}, ${tokenHash}::text))[greatest(cardinality(${S.previousTokenHashes}) + 2 - ${HISTORY_LENGTH}, 1):]`,
      })
      .where(and(eq(S.tokenHash, tokenHash), isNull(S.revokedAt), gt(S.expiresAt, now)))
      .returning();
    return toSession(row);
  },

  /**
   * A live session whose most recent rotation, at or after `since`, retired this token hash.
   * Includes the current token hash so the caller can check the replacement it would hand out again.
   */
  async findJustRotated(tokenHash, since, now = new Date()) {
    const [row] = await db()
      .select()
      .from(S)
      .where(
        and(
          sql`${S.previousTokenHashes}[cardinality(${S.previousTokenHashes})] = ${tokenHash}::text`,
          arrayContains(S.previousTokenHashes, [tokenHash]), // lets the GIN index narrow the scan
          gte(S.lastUsedAt, since),
          isNull(S.revokedAt),
          gt(S.expiresAt, now),
        ),
      )
      .limit(1);
    return row && { ...toSession(row), tokenHash: row.tokenHash };
  },

  /** The session that once held this (already rotated) refresh token. */
  async findByPreviousToken(tokenHash) {
    const [row] = await db().select().from(S).where(arrayContains(S.previousTokenHashes, [tokenHash])).limit(1);
    return toSession(row);
  },

  revokeFamily: (family, reason, now) => revokeWhere(eq(S.family, family), reason, now),

  revoke: (id, reason) => revokeWhere(eq(S.id, id), reason),

  revokeAllForUser: (userId, reason, exceptId) => revokeWhere(and(eq(S.userId, userId), exceptId ? ne(S.id, exceptId) : undefined), reason),

  /** Signed-in devices, most recently used first. */
  async listActive(userId, now = new Date()) {
    const rows = await db()
      .select()
      .from(S)
      .where(and(eq(S.userId, userId), isNull(S.revokedAt), gt(S.expiresAt, now)))
      .orderBy(desc(S.lastUsedAt));
    return rows.map(toSession);
  },
};
