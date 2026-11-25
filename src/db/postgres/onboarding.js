const { and, eq, isNull } = require('drizzle-orm');
const { db } = require('./connection');
const { questionnaires: Q, questionnaireSubmissions: S } = require('./schema');

const toQuestionnaire = (row) => row && { id: row.id, version: row.version, isActive: row.isActive, ...row.definition };

const toSubmission = (row) =>
  row && {
    id: row.id,
    questionnaireId: row.questionnaireId,
    questionnaireVersion: row.questionnaireVersion,
    answers: row.answers,
    scores: row.scores,
    cohort: row.cohort,
    readinessScore: row.readinessScore,
    readinessTier: row.readinessTier,
    tags: row.tags,
    linkedUserId: row.linkedUserId,
    linkedAt: row.linkedAt,
    createdAt: row.createdAt,
  };

const questionnaires = {
  async findActive() {
    const [row] = await db().select().from(Q).where(eq(Q.isActive, true)).limit(1);
    return toQuestionnaire(row);
  },

  async findById(id) {
    const [row] = await db().select().from(Q).where(eq(Q.id, id)).limit(1);
    return toQuestionnaire(row);
  },

  async versionExists(version) {
    return (await db().select({ id: Q.id }).from(Q).where(eq(Q.version, version)).limit(1)).length > 0;
  },

  /** Adds a version and makes it the only active one. */
  async publish({ version, isActive, ...definition }) {
    const row = await db().transaction(async (tx) => {
      await tx.update(Q).set({ isActive: false, updatedAt: new Date() });
      const [inserted] = await tx.insert(Q).values({ version, isActive: true, definition }).returning();
      return inserted;
    });
    return toQuestionnaire(row);
  },
};

const submissions = {
  async create({ questionnaireId, questionnaireVersion, answers, scores, cohort, readinessScore, readinessTier, tags, deviceId, ip }) {
    const [row] = await db()
      .insert(S)
      .values({ questionnaireId, questionnaireVersion, answers, scores, cohort, readinessScore, readinessTier, tags, deviceId, ip })
      .returning();
    return toSubmission(row);
  },

  async findById(id) {
    const [row] = await db().select().from(S).where(eq(S.id, id)).limit(1);
    return toSubmission(row);
  },

  /** Links an unclaimed submission to a new account. False if another account claimed it first. */
  async linkToUser(id, userId, now = new Date()) {
    const rows = await db()
      .update(S)
      .set({ linkedUserId: userId, linkedAt: now, updatedAt: now })
      .where(and(eq(S.id, id), isNull(S.linkedUserId)))
      .returning({ id: S.id });
    return rows.length > 0;
  },
};

module.exports = { questionnaires, submissions };
