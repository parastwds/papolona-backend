const { and, count, desc, eq, isNotNull, ne, sql } = require('drizzle-orm');
const { db } = require('./connection');
const { clueDraws: D, nftSeries: S, profileAccess: A, users: U } = require('./schema');

const toAccess = (row) =>
  row && {
    id: row.id,
    ownerId: row.ownerId,
    viewerId: row.viewerId,
    status: row.status,
    answeredAt: row.answeredAt ?? null,
    createdAt: row.createdAt,
  };

const members = {
  /** What a member's profile shows without access: how many passed readings, completed series and NFTs. */
  async stats(userId) {
    const [[readings], [emblems], [nfts]] = await Promise.all([
      db().select({ n: count() }).from(D).where(and(eq(D.userId, userId), eq(D.verdict, 'pass'))),
      db().select({ n: count() }).from(S).where(and(eq(S.userId, userId), eq(S.status, 'completed'))),
      db().select({ n: count() }).from(S).where(and(eq(S.userId, userId), isNotNull(S.convertedAt))),
    ]);
    return { readings: readings.n, emblems: emblems.n, nfts: nfts.n };
  },

  /** The member's readings, newest first, judged ones only: [{ id, clue, question, generatedAt, verdict, interpretation }]. */
  async readings(userId, limit = 30) {
    return db()
      .select({
        id: D.id,
        clue: D.clue,
        question: D.question,
        generatedAt: D.generatedAt,
        verdict: D.verdict,
        interpretation: D.interpretation,
      })
      .from(D)
      .where(and(eq(D.userId, userId), isNotNull(D.verdict)))
      .orderBy(desc(D.id))
      .limit(limit);
  },

  async findAccess(ownerId, viewerId) {
    const [row] = await db().select().from(A).where(and(eq(A.ownerId, ownerId), eq(A.viewerId, viewerId)));
    return toAccess(row ?? null);
  },

  async findAccessById(id) {
    const [row] = await db().select().from(A).where(eq(A.id, id));
    return toAccess(row ?? null);
  },

  /** Asks `ownerId` for access, or asks again after a denial. Resolves to the request. */
  async requestAccess(ownerId, viewerId, now = new Date()) {
    const [row] = await db()
      .insert(A)
      .values({ ownerId, viewerId, status: 'pending' })
      .onConflictDoUpdate({
        target: [A.ownerId, A.viewerId],
        set: { status: 'pending', answeredAt: null, updatedAt: now, createdAt: now },
        setWhere: ne(A.status, 'approved'),
      })
      .returning();
    return row ? toAccess(row) : members.findAccess(ownerId, viewerId);
  },

  /** Approves or denies a pending request to `ownerId`. Resolves to it, or null when it is not theirs or not pending. */
  async answerAccess(ownerId, id, status, now = new Date()) {
    const [row] = await db()
      .update(A)
      .set({ status, answeredAt: now, updatedAt: now })
      .where(and(eq(A.id, id), eq(A.ownerId, ownerId), eq(A.status, 'pending')))
      .returning();
    return toAccess(row ?? null);
  },

  /** Takes back access the owner approved (or a request they had not answered). */
  async revokeAccess(ownerId, viewerId) {
    await db().delete(A).where(and(eq(A.ownerId, ownerId), eq(A.viewerId, viewerId)));
  },

  /** Requests waiting for `ownerId`, newest first, with who asked: [{ id, createdAt, viewer: { id, name, avatarUrl } }]. */
  async pendingFor(ownerId) {
    const rows = await db()
      .select({ id: A.id, createdAt: A.createdAt, viewerId: U.id, name: U.name, avatarUrl: U.profileAvatarUrl })
      .from(A)
      .innerJoin(U, eq(U.id, A.viewerId))
      .where(and(eq(A.ownerId, ownerId), eq(A.status, 'pending'), sql`${U.status} in ('probation', 'member')`))
      .orderBy(desc(A.createdAt));
    return rows.map((r) => ({ id: r.id, createdAt: r.createdAt, viewer: { id: r.viewerId, name: r.name, avatarUrl: r.avatarUrl } }));
  },
};

module.exports = { members };
