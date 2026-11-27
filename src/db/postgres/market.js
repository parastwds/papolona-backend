const { and, asc, count, desc, eq, inArray, isNull, lt, lte, max, or } = require('drizzle-orm');
const { alias } = require('drizzle-orm/pg-core');
const { db } = require('./connection');
const { nftBids: Bid, nftListings: L, nftSeries: S, payments: P, stoneOrders: O, users: U } = require('./schema');
const { translateDuplicate } = require('./shared');
const { spendIn, creditIn, pennyPayment } = require('./pennies');

const toListing = (row) =>
  row && {
    id: row.id,
    seriesId: row.seriesId,
    sellerId: row.sellerId,
    priceCents: row.priceCents,
    currency: row.currency,
    status: row.status,
    collectorsUntil: row.collectorsUntil ?? null,
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

// Open to everyone: no Collectors' auction, or it has ended.
const openToAll = (now) => or(isNull(L.collectorsUntil), lte(L.collectorsUntil, now));

/** The highest bid on a listing (the earliest of equal ones), within `tx`. */
async function highestBid(tx, listingId) {
  const [row] = await tx
    .select()
    .from(Bid)
    .where(eq(Bid.listingId, listingId))
    .orderBy(desc(Bid.amountCents), asc(Bid.createdAt))
    .limit(1);
  return row ?? null;
}

const market = {
  /**
   * The marketplace: open listings, newest first, before `before` (a createdAt) if given. Listings still in
   * their Collectors' auction are left out unless `collectors` (the viewer is a Collector).
   */
  async listActive({ before = null, limit = 30, collectors = false, now = new Date() } = {}) {
    const rows = await db()
      .select(listingColumns)
      .from(L)
      .innerJoin(S, eq(S.id, L.seriesId))
      .innerJoin(U, eq(U.id, L.sellerId))
      .leftJoin(B, eq(B.id, L.buyerId))
      .where(
        and(
          eq(L.status, 'active'),
          before ? lt(L.createdAt, before) : undefined,
          collectors ? undefined : openToAll(now),
        ),
      )
      .orderBy(desc(L.createdAt), desc(L.id))
      .limit(limit);
    return rows.map(toOffer);
  },

  /**
   * The bids on these listings: { [listingId]: { count, highestCents, highestBidderId, highestBidderName } }.
   * Listings without bids are left out.
   */
  async bidSummaries(listingIds) {
    if (listingIds.length === 0) return {};
    const counts = await db()
      .select({ listingId: Bid.listingId, n: count() })
      .from(Bid)
      .where(inArray(Bid.listingId, listingIds))
      .groupBy(Bid.listingId);
    const top = await db()
      .selectDistinctOn([Bid.listingId], {
        listingId: Bid.listingId,
        amountCents: Bid.amountCents,
        bidderId: Bid.bidderId,
        bidderName: U.name,
      })
      .from(Bid)
      .innerJoin(U, eq(U.id, Bid.bidderId))
      .where(inArray(Bid.listingId, listingIds))
      .orderBy(Bid.listingId, desc(Bid.amountCents), asc(Bid.createdAt));
    const n = Object.fromEntries(counts.map((c) => [c.listingId, c.n]));
    return Object.fromEntries(
      top.map((t) => [
        t.listingId,
        { count: n[t.listingId] ?? 1, highestCents: t.amountCents, highestBidderId: t.bidderId, highestBidderName: t.bidderName },
      ]),
    );
  },

  /**
   * A Collector's bid during a listing's auction, checked and saved under a lock on the listing so bids
   * arrive one at a time. `minNext(highestCents)` is the least a bid may be once there is one. Resolves to
   * { bid } or { error }: 'CLOSED' (sold, withdrawn or not found), 'ENDED' (the auction is over or there is
   * none), 'OWN_LISTING', 'ALREADY_HIGHEST', or 'TOO_LOW' with { minCents }.
   */
  async placeBid(listingId, bidderId, amountCents, minNext, now = new Date()) {
    return db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(L)
        .where(and(eq(L.id, listingId), eq(L.status, 'active')))
        .for('update');
      if (!row) return { error: 'CLOSED' };
      if (!row.collectorsUntil || row.collectorsUntil <= now) return { error: 'ENDED' };
      if (row.sellerId === bidderId) return { error: 'OWN_LISTING' };
      const top = await highestBid(tx, listingId);
      if (top?.bidderId === bidderId) return { error: 'ALREADY_HIGHEST' };
      const minCents = top ? minNext(top.amountCents) : row.priceCents;
      if (amountCents < minCents) return { error: 'TOO_LOW', minCents };
      const [bid] = await tx.insert(Bid).values({ listingId, bidderId, amountCents, createdAt: now }).returning();
      // The bid holds the bidder's pennies (short of them, this throws and the bid is not placed); the
      // bidder it beats gets theirs back.
      await spendIn(tx, bidderId, amountCents, 'bid_hold', listingId, now);
      if (top) await creditIn(tx, top.bidderId, top.amountCents, 'bid_refund', listingId, now);
      return { bid };
    });
  },

  /** Auctions that ended by `now` with at least one bid, still to be settled: [{ id, winnerId }]. */
  async dueAuctions(now = new Date()) {
    const rows = await db()
      .selectDistinctOn([L.id], { id: L.id, winnerId: Bid.bidderId })
      .from(L)
      .innerJoin(Bid, eq(Bid.listingId, L.id))
      .where(and(eq(L.status, 'active'), lte(L.collectorsUntil, now)))
      .orderBy(L.id, desc(Bid.amountCents), asc(Bid.createdAt));
    return rows;
  },

  /**
   * Settles an ended auction: sells the NFT to the highest bidder at their bid, in one transaction (their
   * payment, the listing closed with the fee split, the NFT moved to them). Resolves to
   * { listing, payment, series, winnerId }, or null when it is not due (already settled, withdrawn, no bids).
   */
  async settleAuction(id, { feePercent }, now = new Date()) {
    return db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(L)
        .where(and(eq(L.id, id), eq(L.status, 'active'), lte(L.collectorsUntil, now)))
        .for('update');
      if (!row) return null;
      const top = await highestBid(tx, id);
      if (!top) return null;
      const feeCents = Math.round((top.amountCents * feePercent) / 100);
      // The winner's pennies were held when they bid: the payment records them, the seller gets their share.
      const [paid] = await tx
        .insert(P)
        .values({
          userId: top.bidderId,
          purpose: 'nft_purchase',
          status: 'succeeded',
          createdAt: now,
          ...pennyPayment(top.amountCents),
        })
        .returning();
      if (top.amountCents - feeCents > 0) {
        await creditIn(tx, row.sellerId, top.amountCents - feeCents, 'nft_sale', id, now);
      }
      const [listing] = await tx
        .update(L)
        .set({
          status: 'sold',
          priceCents: top.amountCents,
          buyerId: top.bidderId,
          salePaymentId: paid.id,
          feeCents,
          sellerProceedsCents: top.amountCents - feeCents,
          soldAt: now,
          updatedAt: now,
        })
        .where(eq(L.id, id))
        .returning();
      const [series] = await tx
        .update(S)
        .set({ userId: top.bidderId, updatedAt: now })
        .where(eq(S.id, row.seriesId))
        .returning();
      return { listing: toListing(listing), payment: paid, series, winnerId: top.bidderId };
    });
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

  /**
   * The latest sale of each of these series: { [seriesId]: { priceCents, currency, soldAt, buyerName,
   * sellerName } }. Series never sold are left out.
   */
  async lastSalesBySeries(seriesIds) {
    if (seriesIds.length === 0) return {};
    const Seller = alias(U, 'seller');
    const rows = await db()
      .selectDistinctOn([L.seriesId], {
        seriesId: L.seriesId,
        priceCents: L.priceCents,
        currency: L.currency,
        soldAt: L.soldAt,
        buyerName: B.name,
        sellerName: Seller.name,
      })
      .from(L)
      .innerJoin(Seller, eq(Seller.id, L.sellerId))
      .leftJoin(B, eq(B.id, L.buyerId))
      .where(and(inArray(L.seriesId, seriesIds), eq(L.status, 'sold')))
      .orderBy(L.seriesId, desc(L.soldAt));
    return Object.fromEntries(rows.map((r) => [r.seriesId, r]));
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
  async create({ seriesId, sellerId, priceCents, currency, collectorsUntil = null }, now = new Date()) {
    const [row] = await translateDuplicate(() =>
      db().transaction(async (tx) => {
        const inserted = await tx
          .insert(L)
          .values({ seriesId, sellerId, priceCents, currency, collectorsUntil, status: 'active' })
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

  /**
   * Withdraws the seller's open listing, unless Collectors have bid on it. Resolves to { listing },
   * { error: 'HAS_BIDS' }, or null when it is not open.
   */
  async cancel(sellerId, id, now = new Date()) {
    return db().transaction(async (tx) => {
      const [open] = await tx
        .select()
        .from(L)
        .where(and(eq(L.id, id), eq(L.sellerId, sellerId), eq(L.status, 'active')))
        .for('update');
      if (!open) return null;
      if (await highestBid(tx, id)) return { error: 'HAS_BIDS' };
      const [row] = await tx
        .update(L)
        .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
        .where(eq(L.id, id))
        .returning();
      return { listing: toListing(row) };
    });
  },

  /**
   * Sells an open listing to the buyer, all in one transaction: records the buyer's payment, closes the
   * listing with the fee split and moves the NFT to the buyer. Only once any Collectors' auction has
   * ended without bids. Resolves to { listing, payment, series }, or null when the listing is no longer
   * open (sold to someone else first, withdrawn, still in its auction, or won by a bidder).
   */
  async buy(buyerId, id, { feePercent }, now = new Date()) {
    return db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(L)
        .where(and(eq(L.id, id), eq(L.status, 'active'), openToAll(now)))
        .for('update');
      if (!row) return null;
      if (await highestBid(tx, id)) return null;
      const feeCents = Math.round((row.priceCents * feePercent) / 100);
      const [paid] = await tx
        .insert(P)
        .values({
          userId: buyerId,
          purpose: 'nft_purchase',
          status: 'succeeded',
          createdAt: now,
          ...pennyPayment(row.priceCents),
        })
        .returning();
      // Paid in pennies (short of them, this throws and nothing changes hands); the seller gets their share.
      await spendIn(tx, buyerId, row.priceCents, 'nft_purchase', id, now);
      if (row.priceCents - feeCents > 0) {
        await creditIn(tx, row.sellerId, row.priceCents - feeCents, 'nft_sale', id, now);
      }
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
          .values({ userId, purpose: 'stone', status: 'succeeded', ...pennyPayment(payment.amountCents) })
          .returning();
        await spendIn(tx, userId, payment.amountCents, 'stone', paid.id);
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
