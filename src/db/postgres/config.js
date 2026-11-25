const { asc, eq, sql } = require('drizzle-orm');
const { db } = require('./connection');
const { appConfig: A, legalAcceptances: L } = require('./schema');
const { withDefaults } = require('../appConfig');

const appConfig = {
  /** The app's config, filled in with the defaults for anything not saved yet. */
  async get() {
    const [row] = await db().select().from(A).where(eq(A.key, 'app')).limit(1);
    return withDefaults(row?.config);
  },

  async exists() {
    return (await db().select({ key: A.key }).from(A).where(eq(A.key, 'app')).limit(1)).length > 0;
  },

  async create(config) {
    await db().insert(A).values({ key: 'app', config: withDefaults(config) });
  },

  /** Publishes new Terms / Privacy versions; users who accepted older ones are asked to accept again. */
  async setLegalVersions({ termsVersion, privacyVersion }) {
    const current = await appConfig.get();
    const legal = {
      termsVersion: termsVersion ?? current.legal.termsVersion,
      privacyVersion: privacyVersion ?? current.legal.privacyVersion,
    };
    await db()
      .insert(A)
      .values({ key: 'app', config: { ...current, legal } })
      .onConflictDoUpdate({
        target: A.key,
        set: { config: sql`${A.config} || ${JSON.stringify({ legal })}::jsonb`, updatedAt: new Date() },
      });
  },
};

/** Append-only audit log of Terms / Privacy acceptances. */
const legalAcceptances = {
  async createMany(rows) {
    await db()
      .insert(L)
      .values(rows.map(({ userId, document, version, context, acceptedAt, ip, userAgent }) => ({ userId, document, version, context, acceptedAt, ip, userAgent })));
  },

  async listForUser(userId) {
    const rows = await db().select().from(L).where(eq(L.userId, userId)).orderBy(asc(L.acceptedAt));
    return rows.map((r) => ({ id: r.id, userId: r.userId, document: r.document, version: r.version, context: r.context, acceptedAt: r.acceptedAt }));
  },
};

module.exports = { appConfig, legalAcceptances };
