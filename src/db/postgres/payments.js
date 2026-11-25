const { and, desc, eq, gte, inArray } = require('drizzle-orm');
const { db } = require('./connection');
const { payments: P, users: U, nftListings: L, nftSeries: S, stoneOrders: O } = require('./schema');

const toPayment = (row) =>
  row && {
    id: row.id,
    purpose: row.purpose,
    amountCents: row.amountCents,
    currency: row.currency,
    provider: row.provider,
    status: row.status,
    billing: row.billing ?? null,
    createdAt: row.createdAt,
  };

const payments = {
  /** The user's payments, newest first. */
  async list(userId) {
    const rows = await db().select().from(P).where(eq(P.userId, userId)).orderBy(desc(P.createdAt));
    return rows.map(toPayment);
  },

  /**
   * The user's purchases, newest first: each payment with what it bought. An NFT bought on the marketplace
   * or converted carries its series (rarity, length, artwork); the package carries which package.
   */
  async listPurchases(userId) {
    const rows = await db()
      .select({
        payment: P,
        packageId: O.package,
        boughtSeriesId: L.seriesId,
        boughtFrom: U.name,
        convertedSeriesId: S.id,
      })
      .from(P)
      .leftJoin(O, eq(O.paymentId, P.id))
      .leftJoin(L, eq(L.salePaymentId, P.id))
      .leftJoin(U, eq(U.id, L.sellerId))
      .leftJoin(S, eq(S.conversionPaymentId, P.id))
      .where(and(eq(P.userId, userId), eq(P.status, 'succeeded')))
      .orderBy(desc(P.createdAt));
    const seriesIds = [...new Set(rows.map((r) => r.boughtSeriesId ?? r.convertedSeriesId).filter(Boolean))];
    const series = seriesIds.length
      ? await db()
          .select({ id: S.id, rarity: S.rarity, length: S.length, artworkKey: S.artworkKey })
          .from(S)
          .where(inArray(S.id, seriesIds))
      : [];
    const byId = new Map(series.map((s) => [s.id, s]));
    return rows.map((r) => ({
      ...toPayment(r.payment),
      packageId: r.packageId ?? null,
      seller: r.boughtFrom ?? null,
      series: byId.get(r.boughtSeriesId ?? r.convertedSeriesId) ?? null,
    }));
  },

  /** When the user last paid successfully for `purpose`, or null. */
  async lastPaidAt(userId, purpose) {
    const [row] = await db()
      .select({ createdAt: P.createdAt })
      .from(P)
      .where(and(eq(P.userId, userId), eq(P.purpose, purpose), eq(P.status, 'succeeded')))
      .orderBy(desc(P.createdAt))
      .limit(1);
    return row?.createdAt ?? null;
  },

  /** The user's successful payments for `purpose` since `since`, newest first: [{ amountCents, createdAt }]. */
  async paidSince(userId, purpose, since) {
    return db()
      .select({ amountCents: P.amountCents, createdAt: P.createdAt })
      .from(P)
      .where(and(eq(P.userId, userId), eq(P.purpose, purpose), eq(P.status, 'succeeded'), gte(P.createdAt, since)))
      .orderBy(desc(P.createdAt));
  },

  /** Records a successful payment for `purpose` (demo provider for now). Resolves to it. */
  async record(userId, purpose, { amountCents, currency, provider, providerRef = null, billing = null }) {
    const [row] = await db()
      .insert(P)
      .values({ userId, purpose, amountCents, currency, provider, providerRef, billing, status: 'succeeded' })
      .returning();
    return toPayment(row);
  },

  /**
   * Records a successful membership payment and makes the user a member, together. Only a user still
   * on probation is promoted, so paying twice (two taps, two devices) records nothing the second time:
   * resolves to the payment, or null when the user was not on probation.
   */
  async recordMembership(userId, { amountCents, currency, provider, providerRef = null }, now = new Date()) {
    return db().transaction(async (tx) => {
      const promoted = await tx
        .update(U)
        .set({ status: 'member', memberSince: now, updatedAt: now })
        .where(and(eq(U.id, userId), eq(U.status, 'probation')))
        .returning({ id: U.id });
      if (promoted.length === 0) return null;
      const [row] = await tx
        .insert(P)
        .values({ userId, purpose: 'membership', amountCents, currency, provider, providerRef, status: 'succeeded' })
        .returning();
      return toPayment(row);
    });
  },
};

module.exports = { payments };
