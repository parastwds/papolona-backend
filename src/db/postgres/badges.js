const { asc, eq, inArray } = require('drizzle-orm');
const { db } = require('./connection');
const { userBadges: B } = require('./schema');

const toBadge = (row) => ({ badge: row.badge, seriesId: row.seriesId, awardedAt: row.awardedAt });

const badges = {
  /** The user's badges, oldest first. */
  async listForUser(userId) {
    const rows = await db().select().from(B).where(eq(B.userId, userId)).orderBy(asc(B.awardedAt), asc(B.id));
    return rows.map(toBadge);
  },

  /** Badges of these series: { [seriesId]: ['archive_edition', 'founder'] }. */
  async bySeries(seriesIds) {
    const out = {};
    if (!seriesIds.length) return out;
    const rows = await db().select().from(B).where(inArray(B.seriesId, seriesIds)).orderBy(asc(B.id));
    for (const row of rows) (out[row.seriesId] ??= []).push(row.badge);
    return out;
  },
};

module.exports = { badges };
