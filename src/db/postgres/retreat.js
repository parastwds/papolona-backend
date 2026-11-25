const { eq } = require('drizzle-orm');
const { db } = require('./connection');
const { retreatApplications: R } = require('./schema');
// The unique index refused a second row for the user.
const isDuplicate = (err) => err?.code === '23505' || err?.cause?.code === '23505';

const toApplication = (row) =>
  row && { id: row.id, motivation: row.motivation, status: row.status, createdAt: row.createdAt };

const retreat = {
  /** The user's retreat application, or null. */
  async findApplication(userId) {
    const [row] = await db().select().from(R).where(eq(R.userId, userId));
    return toApplication(row ?? null);
  },

  /** Records the user's application. Resolves to it, or null when they had already applied. */
  async apply(userId, motivation) {
    try {
      const [row] = await db().insert(R).values({ userId, motivation }).returning();
      return toApplication(row);
    } catch (err) {
      if (isDuplicate(err)) return null;
      throw err;
    }
  },
};

module.exports = { retreat };
