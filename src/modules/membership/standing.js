const env = require('../../config/env');
const db = require('../../db');

/**
 * Standing: Creators and Collectors keep their membership by meeting its terms within each period of
 * STANDING_PERIOD_DAYS, counted from when they chose it (their first period is free of terms):
 * - Creator: convert a completed series into an NFT at least once a period. A provisional Creator (before
 *   their first Level 1 conversion) has no terms yet; their first period starts when they become full.
 * - Collector: pay the Collector fee, or buy a member's NFT and keep at least COLLECTOR_MIN_WALLET_CENTS
 *   in their wallet, or buy art (members' NFTs) worth COLLECTOR_ART_YEAR_CENTS in 12 months, which covers
 *   those 12 months.
 * A member who misses their terms returns to Explorer, and can choose Creator or Collector again at any
 * time (which starts a new period). Explorers have no terms. All amounts are demo values for now.
 */

const DAY = 24 * 60 * 60 * 1000;
const YEAR = 365 * DAY;

/**
 * How long art bought in the last 12 months keeps a Collector: until the oldest purchase still needed to
 * reach COLLECTOR_ART_YEAR_CENTS is a year old. Resolves to { artYearCents, artCoveredUntil } (null when the
 * purchases fall short).
 */
async function artYear(userId, now) {
  const purchases = await db.payments.paidSince(userId, 'nft_purchase', new Date(now.getTime() - YEAR));
  let total = 0;
  let coveredUntil = null;
  for (const p of purchases) {
    total += p.amountCents;
    if (!coveredUntil && total >= env.COLLECTOR_ART_YEAR_CENTS) {
      coveredUntil = new Date(new Date(p.createdAt).getTime() + YEAR);
    }
  }
  return { artYearCents: total, artCoveredUntil: coveredUntil };
}
const periodMs = () => env.STANDING_PERIOD_DAYS * DAY;
const plusPeriod = (date) => (date ? new Date(new Date(date).getTime() + periodMs()) : null);
const latest = (...dates) => dates.filter(Boolean).reduce((a, b) => (new Date(b) > new Date(a) ? b : a), null);

/**
 * Where a member stands on their membership's terms: { required, type, met, dueBy, periodDays, ... }.
 * dueBy is when the current period ends without a new qualifying step; `met` is whether that is still ahead.
 */
async function standing(user, now = new Date()) {
  const type = user.membershipType;
  const base = { required: false, type: type ?? null, met: true, dueBy: null, periodDays: env.STANDING_PERIOD_DAYS };
  if (user.status !== 'member' || (type !== 'creator' && type !== 'collector')) return base;
  if (type === 'creator' && !user.creatorConfirmedAt) return { ...base, type };

  // The first period runs from when the membership was chosen (for a Creator, from when they became full,
  // if that was later).
  const since =
    (type === 'creator' ? latest(user.membershipTypeSince, user.creatorConfirmedAt) : user.membershipTypeSince) ??
    user.memberSince ??
    now;
  const firstPeriodEnds = plusPeriod(since);
  const walletCents = user.walletCents ?? 0;

  if (type === 'creator') {
    const lastConversionAt = await db.market.lastConversionAt(user.id);
    const dueBy = latest(firstPeriodEnds, plusPeriod(lastConversionAt));
    return {
      ...base,
      required: true,
      met: new Date(dueBy) > now,
      dueBy,
      lastConversionAt: lastConversionAt ?? null,
      walletCents,
      depositCents: env.CREATOR_DEPOSIT_CENTS,
      currency: 'PNY',
    };
  }

  const [lastFeeAt, lastPurchaseAt, art] = await Promise.all([
    db.payments.lastPaidAt(user.id, 'collector_fee'),
    db.payments.lastPaidAt(user.id, 'nft_purchase'),
    artYear(user.id, now),
  ]);
  const walletOk = walletCents >= env.COLLECTOR_MIN_WALLET_CENTS;
  // A purchase counts only while the wallet holds the minimum; art worth the yearly amount covers a year.
  const dueBy = latest(
    firstPeriodEnds,
    plusPeriod(lastFeeAt),
    walletOk ? plusPeriod(lastPurchaseAt) : null,
    art.artCoveredUntil,
  );
  return {
    ...base,
    required: true,
    met: new Date(dueBy) > now,
    dueBy,
    lastFeeAt: lastFeeAt ?? null,
    lastPurchaseAt: lastPurchaseAt ?? null,
    walletCents,
    walletOk,
    minWalletCents: env.COLLECTOR_MIN_WALLET_CENTS,
    feeCents: env.COLLECTOR_FEE_CENTS,
    // Art bought in the last 12 months, the yearly amount that keeps the membership, and until when it does.
    artYearCents: art.artYearCents,
    artYearTargetCents: env.COLLECTOR_ART_YEAR_CENTS,
    artCoveredUntil: art.artCoveredUntil,
    currency: 'PNY',
  };
}

/**
 * Moves a Creator or Collector whose period ended without meeting its terms back to Explorer. Resolves to
 * { user, demotedFrom }: the user as they now are, and the membership they lost (null if none).
 */
async function enforce(user, now = new Date()) {
  const current = await standing(user, now);
  if (!current.required || current.met) return { user, demotedFrom: null };
  await db.users.setMembershipType(user.id, 'explorer', now);
  return { user: await db.users.findById(user.id), demotedFrom: user.membershipType };
}

module.exports = { standing, enforce };
