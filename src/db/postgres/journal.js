const { and, asc, count, desc, eq, gt, gte, isNull, lt, lte, ne, notExists, or, sql } = require('drizzle-orm');
const { alias } = require('drizzle-orm/pg-core');
const { db } = require('./connection');
const { clueDraws: D, journalEntries: J, journalInsights: I, users: U } = require('./schema');
const { translateDuplicate } = require('./shared');

const drawColumns = {
  id: D.id,
  clue: D.clue,
  question: D.question,
  generatedAt: D.generatedAt,
  interpretation: D.interpretation,
  interpretationSource: D.interpretationSource,
  verdict: D.verdict,
  judgement: D.judgement,
  judgedAt: D.judgedAt,
  attempts: D.attempts,
  userEeriness: D.userEeriness,
  userSatisfaction: D.userSatisfaction,
  ratedAt: D.ratedAt,
  aiEeriness: D.aiEeriness,
  aiSatisfaction: D.aiSatisfaction,
  seriesId: D.seriesId,
  tileIndex: D.tileIndex,
  prompt: D.prompt,
};

// The user's and the AI's eeriness/satisfaction ratings; null when neither has rated yet.
const toRatings = (row) => {
  const user =
    row.userSatisfaction != null
      ? { eeriness: row.userEeriness, satisfaction: row.userSatisfaction, ratedAt: row.ratedAt }
      : null;
  const ai = row.aiEeriness != null ? { eeriness: row.aiEeriness, satisfaction: row.aiSatisfaction } : null;
  return user || ai ? { user, ai } : null;
};

// A reading: the draw, and its interpretation with the judge's verdict once judged (null until then).
const toDraw = (row) =>
  row && {
    id: row.id,
    clue: row.clue,
    question: row.question,
    generatedAt: row.generatedAt,
    ...(row.nextAvailableAt !== undefined && { nextAvailableAt: row.nextAvailableAt }),
    interpretation: row.verdict
      ? {
          text: row.interpretation,
          source: row.interpretationSource,
          verdict: row.verdict,
          parts: row.judgement?.parts ?? [],
          feedback: row.judgement?.feedback ?? '',
          judgedAt: row.judgedAt,
        }
      : null,
    // How many times the interpretation has been judged (a fail may be resubmitted).
    attempts: row.attempts ?? 0,
    ratings: toRatings(row),
    // The NFT series it was drawn in, and the tile its pass revealed.
    seriesId: row.seriesId ?? null,
    tileIndex: row.tileIndex ?? null,
    // The multiple-choice splits the AI offered when the user tapped the clue for a prompt (null if never).
    prompt: row.prompt?.options ?? null,
  };

const clueDraws = {
  async create({ userId, clue, question, generatedAt, nextAvailableAt, seriesId = null }) {
    const [row] = await db()
      .insert(D)
      .values({ userId, clue, question, generatedAt, nextAvailableAt, seriesId })
      .returning();
    return toDraw({ ...row, nextAvailableAt: undefined });
  },

  /**
   * Creates a draw unless the user's latest one still waits for its interpretation (only the latest can be
   * interpreted, so none is skipped) and was drawn after `openSince` (older ones have run out of time).
   * The user's row is locked, so two requests at once can't both draw. Returns null when refused.
   */
  async createUnlessOpen({ userId, clue, question, generatedAt, seriesId = null, openSince }) {
    return db().transaction(async (tx) => {
      await tx.select({ id: U.id }).from(U).where(eq(U.id, userId)).for('update');
      const [latest] = await tx
        .select({ verdict: D.verdict, generatedAt: D.generatedAt })
        .from(D)
        .where(eq(D.userId, userId))
        .orderBy(desc(D.generatedAt))
        .limit(1);
      if (latest && !latest.verdict && latest.generatedAt > openSince) return null;
      const [row] = await tx
        .insert(D)
        .values({ userId, clue, question, generatedAt, nextAvailableAt: generatedAt, seriesId })
        .returning();
      return toDraw({ ...row, nextAvailableAt: undefined });
    });
  },

  /** The newest draw, with nextAvailableAt: while that is ahead, new journal entries are sealed to it. */
  async latestForUser(userId) {
    const [row] = await db()
      .select({ ...drawColumns, nextAvailableAt: D.nextAvailableAt })
      .from(D)
      .where(eq(D.userId, userId))
      .orderBy(desc(D.generatedAt))
      .limit(1);
    return toDraw(row ?? null);
  },

  /** The user's readings, newest first (ids are time-ordered UUIDv7). `before` is the last id of the previous page. */
  async list(userId, { before, limit }) {
    const rows = await db()
      .select(drawColumns)
      .from(D)
      .where(and(eq(D.userId, userId), before ? lt(D.id, before) : undefined))
      .orderBy(desc(D.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return { readings: page.map(toDraw), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
  },

  /**
   * Saves a judged attempt, replacing the one before, only if the reading has not passed and is still on
   * attempt `attempt` (counting from 1): two requests racing can't both use the same attempt.
   * Returns the updated reading, or null when another request judged it first.
   */
  async saveJudgement(userId, id, { attempt, text, source, verdict, parts, feedback, eeriness, satisfaction, model, judgedAt }) {
    const [row] = await db()
      .update(D)
      .set({
        interpretation: text,
        interpretationSource: source,
        verdict,
        judgement: { parts, feedback, model },
        judgedAt,
        aiEeriness: eeriness ?? null,
        aiSatisfaction: satisfaction ?? null,
        attempts: attempt,
      })
      .where(
        and(
          eq(D.id, id),
          eq(D.userId, userId),
          eq(D.attempts, attempt - 1),
          or(isNull(D.verdict), eq(D.verdict, 'fail')),
        ),
      )
      .returning();
    return row ? toDraw({ ...row, nextAvailableAt: undefined }) : null;
  },

  /**
   * Saves the AI prompt for a clue, only if it has none yet and has not passed: one prompt per clue, even
   * when two requests race. Returns the updated reading, or null when it already had one (or passed).
   */
  async savePrompt(userId, id, { options, model, promptedAt }) {
    const [row] = await db()
      .update(D)
      .set({ prompt: { options, model }, promptedAt })
      .where(
        and(eq(D.id, id), eq(D.userId, userId), isNull(D.promptedAt), or(isNull(D.verdict), eq(D.verdict, 'fail'))),
      )
      .returning();
    return row ? toDraw({ ...row, nextAvailableAt: undefined }) : null;
  },

  /**
   * Readings entering their last hour: each user's latest draw, not passed, with attempts left, drawn in
   * (from, to], not warned yet, for users with series deadline emails on.
   */
  async lastHourCandidates(from, to, maxAttempts, limit) {
    const later = alias(D, 'later');
    return db()
      .select({ id: D.id, clue: D.clue, generatedAt: D.generatedAt, userId: U.id, name: U.name, email: U.email })
      .from(D)
      .innerJoin(U, eq(U.id, D.userId))
      .where(
        and(
          gt(D.generatedAt, from),
          lte(D.generatedAt, to),
          isNull(D.deadlineWarnedAt),
          or(isNull(D.verdict), ne(D.verdict, 'pass')),
          lt(D.attempts, maxAttempts),
          eq(U.notifySequenceDeadline, true),
          isNull(U.deletedAt),
          notExists(
            db()
              .select({ id: later.id })
              .from(later)
              .where(and(eq(later.userId, D.userId), gt(later.generatedAt, D.generatedAt))),
          ),
        ),
      )
      .limit(limit);
  },

  /** Marks the warning as sent, only once: false when another run sent it first. */
  async claimDeadlineWarning(id, now) {
    const rows = await db()
      .update(D)
      .set({ deadlineWarnedAt: now })
      .where(and(eq(D.id, id), isNull(D.deadlineWarnedAt)))
      .returning({ id: D.id });
    return rows.length > 0;
  },

  /** How many prompts the user has taken since `from` (the start of their prompt month). */
  async countPromptsSince(userId, from) {
    const [row] = await db()
      .select({ n: count() })
      .from(D)
      .where(and(eq(D.userId, userId), gte(D.promptedAt, from)));
    return row.n;
  },

  /**
   * Saves the user's own rating of one of their readings; an eeriness left out keeps the one saved before.
   * Null when it is not theirs.
   */
  async saveUserRating(userId, id, { eeriness, satisfaction, ratedAt }) {
    const [row] = await db()
      .update(D)
      .set({ userSatisfaction: satisfaction, ratedAt, ...(eeriness != null && { userEeriness: eeriness }) })
      .where(and(eq(D.id, id), eq(D.userId, userId)))
      .returning();
    return row ? toDraw({ ...row, nextAvailableAt: undefined }) : null;
  },

  /** When each draw in [from, to) was made, oldest first (calendar marks). */
  async generatedBetween(userId, from, to) {
    const rows = await db()
      .select({ at: D.generatedAt })
      .from(D)
      .where(and(eq(D.userId, userId), gte(D.generatedAt, from), lt(D.generatedAt, to)))
      .orderBy(asc(D.generatedAt));
    return rows.map((r) => r.at);
  },

  /** How many clues the user has ever drawn. */
  async countForUser(userId) {
    const [row] = await db().select({ n: count() }).from(D).where(eq(D.userId, userId));
    return row.n;
  },

  /** How many of the user's interpretations the judge passed: their days of probation. */
  async countPassed(userId) {
    const [row] = await db()
      .select({ n: count() })
      .from(D)
      .where(and(eq(D.userId, userId), eq(D.verdict, 'pass')));
    return row.n;
  },
};

// Each entry with the clue it was sealed with (null while still open).
const selectEntries = () =>
  db()
    .select({
      id: J.id,
      clientId: J.clientId,
      text: J.text,
      source: J.source,
      photos: J.photos,
      createdAt: J.createdAt,
      clue: D.clue,
      clueGeneratedAt: D.generatedAt,
    })
    .from(J)
    .leftJoin(D, eq(J.clueDrawId, D.id));

const toPhoto = ({ publicId, url, width, height }) => ({ publicId, url, width, height });
const photoIdsOf = (rows) => rows.flatMap((r) => (r.photos ?? []).map((p) => p.publicId));

const toEntry = (row) =>
  row && {
    id: row.id,
    clientId: row.clientId,
    text: row.text,
    source: row.source,
    photos: (row.photos ?? []).map(toPhoto),
    createdAt: row.createdAt,
    clue: row.clue ? { clue: row.clue, generatedAt: row.clueGeneratedAt } : null,
  };

const journal = {
  /** Newest first (ids are time-ordered UUIDv7). `before` is the id of the last entry of the previous page. */
  async list(userId, { before, limit }) {
    const rows = await selectEntries()
      .where(and(eq(J.userId, userId), before ? lt(J.id, before) : undefined))
      .orderBy(desc(J.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return { entries: page.map(toEntry), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
  },

  /** Throws DuplicateError when the user already has an entry with this clientId. */
  async create({ userId, text, source, clientId, photos = [], clueDrawId = null }) {
    const [row] = await translateDuplicate(() =>
      db().insert(J).values({ userId, text, source, clientId, photos, clueDrawId }).returning(),
    );
    if (!row.clueDrawId) return toEntry({ ...row, clue: null });
    const [sealed] = await selectEntries().where(eq(J.id, row.id)).limit(1);
    return toEntry(sealed);
  },

  async findByClientId(userId, clientId) {
    const [row] = await selectEntries()
      .where(and(eq(J.userId, userId), eq(J.clientId, clientId)))
      .limit(1);
    return toEntry(row);
  },

  /** Entries created in [from, to), oldest first (one day of the journal). */
  async listBetween(userId, from, to) {
    const rows = await selectEntries()
      .where(and(eq(J.userId, userId), gte(J.createdAt, from), lt(J.createdAt, to)))
      .orderBy(asc(J.id));
    return rows.map(toEntry);
  },

  /** Seals every open entry to the clue just drawn. */
  async sealOpen(userId, clueDrawId) {
    await db()
      .update(J)
      .set({ clueDrawId })
      .where(and(eq(J.userId, userId), isNull(J.clueDrawId)));
  },

  /** When each entry in [from, to) was written, oldest first (calendar marks). */
  async createdBetween(userId, from, to) {
    const rows = await db()
      .select({ at: J.createdAt })
      .from(J)
      .where(and(eq(J.userId, userId), gte(J.createdAt, from), lt(J.createdAt, to)))
      .orderBy(asc(J.createdAt));
    return rows.map((r) => r.at);
  },

  /** null when there is no such entry for this user; otherwise the publicIds of its photos, to delete from Cloudinary. */
  async remove(userId, id) {
    const rows = await db()
      .delete(J)
      .where(and(eq(J.id, id), eq(J.userId, userId)))
      .returning({ photos: J.photos });
    return rows.length ? { photoIds: photoIdsOf(rows) } : null;
  },

  /** Deletes the entries not yet sealed by a clue; returns how many, and their photos' publicIds. */
  async removeOpen(userId) {
    const rows = await db()
      .delete(J)
      .where(and(eq(J.userId, userId), isNull(J.clueDrawId)))
      .returning({ photos: J.photos });
    return { deleted: rows.length, photoIds: photoIdsOf(rows) };
  },

  /** Returns the publicIds of the deleted entries' photos. */
  async removeAllForUser(userId) {
    const rows = await db().delete(J).where(eq(J.userId, userId)).returning({ photos: J.photos });
    return { photoIds: photoIdsOf(rows) };
  },
};

const toInsight = (row) =>
  row
    ? {
        day: row.day,
        entriesHash: row.entriesHash,
        refined: row.refined,
        questions: row.questions,
        model: row.model,
        generatedAt: row.updatedAt,
      }
    : null;

/** The AI reading of each journal day; one per user and day. */
const journalInsights = {
  async find(userId, day) {
    const [row] = await db()
      .select()
      .from(I)
      .where(and(eq(I.userId, userId), eq(I.day, day)))
      .limit(1);
    return toInsight(row);
  },

  /** Creates or replaces the day's insight. */
  // `questions` is no longer generated; the column stays, empty, for readings made before.
  async save(userId, day, { entriesHash, refined, questions = [], model }) {
    const now = new Date();
    const [row] = await db()
      .insert(I)
      .values({ userId, day, entriesHash, refined, questions, model })
      .onConflictDoUpdate({ target: [I.userId, I.day], set: { entriesHash, refined, questions, model, updatedAt: now } })
      .returning();
    return toInsight(row);
  },

  async removeAllForUser(userId) {
    await db().delete(I).where(eq(I.userId, userId));
  },
};

module.exports = { clueDraws, journal, journalInsights };
