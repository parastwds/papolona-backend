const { and, desc, eq, inArray, isNotNull, isNull, lt, notExists, sql } = require('drizzle-orm');
const { alias } = require('drizzle-orm/pg-core');
const { db } = require('./connection');
const { nftSeries: S, clueDraws: D, payments: P, users: U, nftListings: L } = require('./schema');
const { translateDuplicate } = require('./shared');

// The whole series, revealOrder included; the service decides what the app sees.
const toSeries = (row) =>
  row && {
    id: row.id,
    userId: row.userId,
    length: row.length,
    rows: row.rows,
    cols: row.cols,
    rarity: row.rarity,
    status: row.status,
    artworkKey: row.artworkKey,
    revealOrder: row.revealOrder,
    revealedTiles: row.revealedTiles,
    startedAt: row.startedAt,
    lastReadingAt: row.lastReadingAt,
    deadlineAt: row.deadlineAt,
    completedAt: row.completedAt,
    abandonedAt: row.abandonedAt,
    failedAt: row.failedAt ?? null,
    publishedAt: row.publishedAt ?? null,
    mintChoice: row.mintChoice ?? null,
    mintChoiceAt: row.mintChoiceAt ?? null,
    creatorId: row.creatorId ?? row.userId,
    convertedAt: row.convertedAt ?? null,
  };

// Who completed a series: it stays theirs on the collective artwork even after it is sold.
const C = alias(U, 'creator');

// A published series on the collective artwork, with its owner's and its maker's names.
const toPublished = (row) =>
  row && {
    ...toSeries(row.series),
    owner: { id: row.ownerId, name: row.ownerName },
    creator: { id: row.creatorId ?? row.ownerId, name: row.creatorName ?? row.ownerName },
  };

const publishedColumns = { series: S, ownerId: U.id, ownerName: U.name, creatorId: C.id, creatorName: C.name };

// Only 3, 6, 12 and 24 reading series have an emblem, so only they are on the collective artwork.
const EMBLEM_LENGTHS = [3, 6, 12, 24];
const onWall = () => and(isNotNull(S.publishedAt), inArray(S.length, EMBLEM_LENGTHS));

const series = {
  async findActive(userId) {
    const [row] = await db()
      .select()
      .from(S)
      .where(and(eq(S.userId, userId), eq(S.status, 'active')));
    return toSeries(row ?? null);
  },

  async findById(userId, id) {
    const [row] = await db()
      .select()
      .from(S)
      .where(and(eq(S.id, id), eq(S.userId, userId)));
    return toSeries(row ?? null);
  },

  /** All the user's series, newest first, abandoned ones included (the service decides which to show). */
  async list(userId) {
    const rows = await db()
      .select()
      .from(S)
      .where(eq(S.userId, userId))
      .orderBy(desc(S.startedAt));
    return rows.map(toSeries);
  },

  /** Starts a series. Throws DuplicateError when the user already has an active one. */
  async create(userId, fields) {
    const [row] = await translateDuplicate(() =>
      db()
        .insert(S)
        .values({ ...fields, userId, creatorId: userId, status: 'active' })
        .returning(),
    );
    return toSeries(row);
  },

  /**
   * Fails the user's active series when its latest reading was not passed in time: drawn at or before
   * `cutoff` (now minus the reading window). Resolves to the failed series, or null.
   */
  async failIfExpired(userId, now, cutoff) {
    const [row] = await db()
      .update(S)
      .set({ status: 'failed', failedAt: now, updatedAt: now })
      .where(
        and(
          eq(S.userId, userId),
          eq(S.status, 'active'),
          sql`exists (
            select 1 from clue_draws d
            where d.series_id = ${S.id}
              and d.verdict is distinct from 'pass'
              and d.generated_at <= ${cutoff.toISOString()}::timestamptz
              and not exists (
                select 1 from clue_draws later where later.series_id = d.series_id and later.generated_at > d.generated_at
              )
          )`,
        ),
      )
      .returning();
    return toSeries(row ?? null);
  },

  /** A reading in the active series failed all its attempts: the series has failed. Resolves to it, or null. */
  async fail(id, now) {
    const [row] = await db()
      .update(S)
      .set({ status: 'failed', failedAt: now, updatedAt: now })
      .where(and(eq(S.id, id), eq(S.status, 'active')))
      .returning();
    return toSeries(row ?? null);
  },

  /** A reading was drawn in the series: it moves the deadline on. */
  async recordDraw(id, { at, deadlineAt }) {
    const [row] = await db()
      .update(S)
      .set({ lastReadingAt: at, deadlineAt, updatedAt: at })
      .where(and(eq(S.id, id), eq(S.status, 'active')))
      .returning();
    return toSeries(row ?? null);
  },

  /**
   * A reading in the series passed: reveals the next tile (in revealOrder) and records it on the draw,
   * completing the series with its last tile. Locked so two passes can't reveal the same tile.
   * Resolves to { series, tileIndex }, or null when the series is no longer active.
   */
  async revealNext(id, drawId, now) {
    return db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(S)
        .where(and(eq(S.id, id), eq(S.status, 'active')))
        .for('update');
      if (!row) return null;
      const tileIndex = row.revealOrder[row.revealedTiles.length];
      const revealedTiles = [...row.revealedTiles, tileIndex];
      const complete = revealedTiles.length === row.length;
      const [updated] = await tx
        .update(S)
        .set({
          revealedTiles,
          ...(complete && { status: 'completed', completedAt: now }),
          updatedAt: now,
        })
        .where(eq(S.id, id))
        .returning();
      await tx.update(D).set({ tileIndex }).where(eq(D.id, drawId));
      return { series: toSeries(updated), tileIndex };
    });
  },
};

Object.assign(series, {
  /**
   * Places a completed series on the collective artwork (free). Resolves to { series }, or null when the
   * series is not the user's, not completed, or already there.
   */
  async publish(userId, id, now = new Date()) {
    const [row] = await db()
      .update(S)
      .set({ publishedAt: now, updatedAt: now })
      .where(and(eq(S.id, id), eq(S.userId, userId), eq(S.status, 'completed'), isNull(S.publishedAt)))
      .returning();
    return row ? { series: toSeries(row) } : null;
  },

  /**
   * Takes the user's series off the collective artwork (private again), unless it is up for sale: an open
   * listing keeps it public. Resolves to { series }, or null when it is not the user's, not on the
   * artwork, or listed.
   */
  async unpublish(userId, id, now = new Date()) {
    const listed = db()
      .select({ id: L.id })
      .from(L)
      .where(and(eq(L.seriesId, S.id), eq(L.status, 'active')));
    const [row] = await db()
      .update(S)
      .set({ publishedAt: null, updatedAt: now })
      .where(and(eq(S.id, id), eq(S.userId, userId), isNotNull(S.publishedAt), notExists(listed)))
      .returning();
    return row ? { series: toSeries(row) } : null;
  },

  /**
   * Converts the user's completed series into an NFT, recording its payment in the same transaction.
   * `choice` is 'mint' or 'mint_poc'. Resolves to { series, payment }, or null when the series is not the
   * user's, not completed, or already converted (so a double tap pays once).
   */
  async convert(userId, id, choice, payment, now = new Date()) {
    return db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(S)
        .where(and(eq(S.id, id), eq(S.userId, userId), eq(S.status, 'completed'), isNull(S.convertedAt)))
        .for('update');
      if (!row) return null;
      const [paid] = await tx
        .insert(P)
        .values({ userId, purpose: 'conversion', status: 'succeeded', ...payment })
        .returning();
      const [updated] = await tx
        .update(S)
        .set({ convertedAt: now, conversionPaymentId: paid.id, mintChoice: choice, mintChoiceAt: now, updatedAt: now })
        .where(eq(S.id, id))
        .returning();
      return { series: toSeries(updated), payment: paid };
    });
  },

  /** Records the mint choice on the user's completed series. Resolves to the series, or null. */
  async setMintChoice(userId, id, choice, now = new Date()) {
    const [row] = await db()
      .update(S)
      .set({ mintChoice: choice, mintChoiceAt: now, updatedAt: now })
      .where(and(eq(S.id, id), eq(S.userId, userId), eq(S.status, 'completed')))
      .returning();
    return toSeries(row ?? null);
  },

  /** The collective artwork: published series, newest first, before `before` (a publishedAt) if given. */
  async listPublished({ before = null, limit = 30 } = {}) {
    const rows = await db()
      .select(publishedColumns)
      .from(S)
      .innerJoin(U, eq(U.id, S.userId))
      .leftJoin(C, eq(C.id, S.creatorId))
      .where(and(onWall(), before ? lt(S.publishedAt, before) : undefined))
      .orderBy(desc(S.publishedAt), desc(S.id))
      .limit(limit);
    return rows.map(toPublished);
  },

  /** One published series, or null. */
  async findPublished(id) {
    const [row] = await db()
      .select(publishedColumns)
      .from(S)
      .innerJoin(U, eq(U.id, S.userId))
      .leftJoin(C, eq(C.id, S.creatorId))
      .where(and(eq(S.id, id), onWall()));
    return toPublished(row ?? null);
  },

  /** The published series a member made (their public gallery), newest first. */
  async listPublishedByUser(userId) {
    const rows = await db()
      .select(publishedColumns)
      .from(S)
      .innerJoin(U, eq(U.id, S.userId))
      .leftJoin(C, eq(C.id, S.creatorId))
      .where(and(eq(S.creatorId, userId), onWall()))
      .orderBy(desc(S.publishedAt));
    return rows.map(toPublished);
  },

  /** The passed readings of a series, in the order they were drawn: what each clue meant. */
  async readings(seriesId) {
    return db()
      .select({
        id: D.id,
        clue: D.clue,
        question: D.question,
        interpretation: D.interpretation,
        judgement: D.judgement,
        generatedAt: D.generatedAt,
        tileIndex: D.tileIndex,
      })
      .from(D)
      .where(and(eq(D.seriesId, seriesId), eq(D.verdict, 'pass')))
      .orderBy(D.generatedAt);
  },
});

module.exports = { series };
