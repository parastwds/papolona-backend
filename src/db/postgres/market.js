const { and, desc, eq, inArray, isNull, lt, max } = require('drizzle-orm');
const { alias } = require('drizzle-orm/pg-core');
const { db } = require('./connection');
const { nftListings: L, nftSeries: S, payments: P, stoneOrders: O, users: U } = require('./schema');
const { translateDuplicate } = require('./shared');

const toListing = (row) =>
  row && {
    id: row.id,
    seriesId: row.seriesId,
    sellerId: row.sellerId,
    priceCents: row.priceCents,
    currency: row.currency,
    status: row.status,
    buyerId: row.buyerId ?? null,
    feeCents: row.feeCents ?? null,
    sellerProceedsCents: row.sellerProceedsCents ?? null,
    soldAt: row.soldAt ?? null,
    cancelledAt: row.cancelledAt ?? null,
    createdAt: row.createdAt,
  };

const toStoneOrder = (row) =>
  row && {
    id: row.id,
    package: row.package,
    recipientName: row.recipientName,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    postcode: row.postcode,
    country: row.country,
    createdAt: row.createdAt,
  };

// Who bought a sold listing.
const B = alias(U, 'buyer');

// A listing with the NFT it offers, the seller's name and (once sold) the buyer's, for the marketplace.
const listingColumns = { listing: L, series: S, sellerName: U.name, buyerName: B.name };
const toOffer = (row) =>
  row && { ...toListing(row.listing), series: row.series, sellerName: row.sellerName, buyerName: row.buyerName ?? null };

const isDuplicate = (err) => err?.code === '23505' || err?.cause?.code === '23505';

const market = {
  /** The marketplace: open listings, newest first, before `before` (a createdAt) if given. */
  async listActive({ before = null, limit = 30 } = {}) {
    const rows = await db()
      .select(listingColumns)
      .from(L)
      .innerJoin(S, eq(S.id, L.seriesId))
      .innerJoin(U, eq(U.id, L.sellerId))
      .leftJoin(B, eq(B.id, L.buyerId))
      .where(and(eq(L.status, 'active'), before ? lt(L.createdAt, before) : undefined))
      .orderBy(desc(L.createdAt), desc(L.id))
      .limit(limit);
    return rows.map(toOffer);
  },

  /** One listing with its NFT and seller, whatever its status, or null. */
  async findOffer(id) {
    const [row] = await db()
      .select(listingColumns)
      .from(L)
      .innerJoin(S, eq(S.id, L.seriesId))
      .innerJoin(U, eq(U.id, L.sellerId))
      .leftJoin(B, eq(B.id, L.buyerId))
      .where(eq(L.id, id));
    return toOffer(row ?? null);
  },

  /** Open listings of these series: { [seriesId]: listing }. */
  async activeBySeries(seriesIds) {
    if (seriesIds.length === 0) return {};
    const rows = await db()
      .select()
      .from(L)
      .where(and(inArray(L.seriesId, seriesIds), eq(L.status, 'active')));
    return Object.fromEntries(rows.map((r) => [r.seriesId, toListing(r)]));
  },

  /** The user's listings as a seller, newest first. */
  async listBySeller(userId) {
    const rows = await db()
      .select(listingColumns)
      .from(L)
      .innerJoin(S, eq(S.id, L.seriesId))
      .innerJoin(U, eq(U.id, L.sellerId))
      .leftJoin(B, eq(B.id, L.buyerId))
      .where(eq(L.sellerId, userId))
      .orderBy(desc(L.createdAt));
    return rows.map(toOffer);
  },

  /**
   * Opens a listing and places the NFT on the collective artwork if it isn't there yet: selling it makes it
   * public. Throws DuplicateError when the series is already listed.
   */
  async create({ seriesId, sellerId, priceCents, currency }, now = new Date()) {
    const [row] = await translateDuplicate(() =>
      db().transaction(async (tx) => {
        const inserted = await tx
          .insert(L)
          .values({ seriesId, sellerId, priceCents, currency, status: 'active' })
          .returning();
        await tx
          .update(S)
          .set({ publishedAt: now, updatedAt: now })
          .where(and(eq(S.id, seriesId), isNull(S.publishedAt)));
        return inserted;
      }),
    );
    return toListing(row);
  },

  /** Withdraws the seller's open listing. Resolves to it, or null. */
  async cancel(sellerId, id, now = new Date()) {
    const [row] = await db()
      .update(L)
      .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
      .where(and(eq(L.id, id), eq(L.sellerId, sellerId), eq(L.status, 'active')))
      .returning();
    return toListing(row ?? null);
  },

  /**
   * Sells an open listing to the buyer, all in one transaction: records the buyer's payment, closes the
   * listing with the fee split and moves the NFT to the buyer. Resolves to { listing, payment, series },
   * or null when the listing is no longer open (sold to someone else first, or withdrawn).
   */
  async buy(buyerId, id, { feePercent, payment }, now = new Date()) {
    return db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(L)
        .where(and(eq(L.id, id), eq(L.status, 'active')))
        .for('update');
      if (!row) return null;
      const feeCents = Math.round((row.priceCents * feePercent) / 100);
      const [paid] = await tx
        .insert(P)
        .values({
          userId: buyerId,
          purpose: 'nft_purchase',
          status: 'succeeded',
          amountCents: row.priceCents,
          currency: row.currency,
          ...payment,
        })
        .returning();
      const [listing] = await tx
        .update(L)
        .set({
          status: 'sold',
          buyerId,
          salePaymentId: paid.id,
          feeCents,
          sellerProceedsCents: row.priceCents - feeCents,
          soldAt: now,
          updatedAt: now,
        })
        .where(eq(L.id, id))
        .returning();
      const [series] = await tx
        .update(S)
        .set({ userId: buyerId, updatedAt: now })
        .where(eq(S.id, row.seriesId))
        .returning();
      return { listing: toListing(listing), payment: paid, series };
    });
  },

  /** When the user last paid for a conversion, or null: an active member converts one every so often. */
  async lastConversionAt(userId) {
    const [row] = await db()
      .select({ at: max(P.createdAt) })
      .from(P)
      .where(and(eq(P.userId, userId), eq(P.purpose, 'conversion'), eq(P.status, 'succeeded')));
    return row?.at ? new Date(row.at) : null;
  },

  /** The user's meditation stone order, or null. */
  async findStoneOrder(userId) {
    const [row] = await db().select().from(O).where(eq(O.userId, userId));
    return toStoneOrder(row ?? null);
  },

  /**
   * Orders the meditation stone, recording its payment in the same transaction. Resolves to
   * { order, payment }, or null when the user already ordered one.
   */
  async orderStone(userId, packageId, address, payment) {
    try {
      return await db().transaction(async (tx) => {
        const [paid] = await tx
          .insert(P)
          .values({ userId, purpose: 'stone', status: 'succeeded', ...payment })
          .returning();
        const [order] = await tx
          .insert(O)
          .values({ userId, paymentId: paid.id, package: packageId, ...address })
          .returning();
        return { order: toStoneOrder(order), payment: paid };
      });
    } catch (err) {
      // A second request ordered first: the unique index rolled this one back, payment included.
      if (isDuplicate(err)) return null;
      throw err;
    }
  },

  /**
   * Members whose active window closes between `from` and `to`, who want deadline emails and have not
   * been nudged for that window yet: [{ id, name, email, activeUntil }]. A conversion keeps a member
   * active for `windowMs`.
   */
  async activeReminderCandidates(from, to, windowMs) {
    const rows = await db()
      .select({
        id: U.id,
        name: U.name,
        email: U.email,
        notify: U.notifySequenceDeadline,
        sentFor: U.activeReminderFor,
        last: max(P.createdAt),
      })
      .from(U)
      .innerJoin(P, and(eq(P.userId, U.id), eq(P.purpose, 'conversion'), eq(P.status, 'succeeded')))
      .where(eq(U.status, 'member'))
      .groupBy(U.id);
    return rows
      .map((r) => ({ ...r, activeUntil: new Date(new Date(r.last).getTime() + windowMs) }))
      .filter(
        (r) =>
          r.notify &&
          r.activeUntil > from &&
          r.activeUntil <= to &&
          (!r.sentFor || r.sentFor.getTime() !== r.activeUntil.getTime()),
      )
      .map(({ id, name, email, activeUntil }) => ({ id, name, email, activeUntil }));
  },

  /** Marks the nudge for this window as sent. */
  async markActiveReminder(userId, activeUntil) {
    await db().update(U).set({ activeReminderFor: activeUntil }).where(eq(U.id, userId));
  },
};

module.exports = { market };
