const crypto = require('crypto');
const env = require('../../config/env');
const db = require('../../db');
const billingService = require('../billing/billing.service');
const { DuplicateError } = require('../../db/errors');
const ApiError = require('../../utils/ApiError');
const standing = require('../membership/standing');

/**
 * Series: after probation, a member may choose a run of 1, 2, 3, 6, 12 or 24 readings (Explorers: 1, 2 and
 * 3). Readings are the usual clue, interpretation and journal. In any series each reading the judge passes
 * earns one butterfly emblem, filling one tile of the series' grid in a random
 * order; a fail earns nothing, and the member may resubmit it or move on to the next clue. A reading that
 * fails all its attempts (see clue.service) fails the whole series. The complete set of emblems is one NFT;
 * emblems of an abandoned or failed series stay in the gallery but can never be converted.
 * Each reading must be completed (passed) within READING_WINDOW_HOURS of its draw; a reading left
 * unfinished past that fails the series too. There is no limit on the time between readings.
 *
 * Rewards: singles and twins are practice: they earn emblems, kept in the gallery, but never become NFTs. A Triple (3), Hexa (6), Dozen (12) or Double
 * Dozen (24) earns a butterfly emblem whose rarity rises with the length (common, epic, mythic,
 * legendary). The member keeps it in the gallery or converts it into an NFT for the length's conversion
 * price (demo payments for now; no on-chain minting yet), optionally joining the POC ecosystem. Each
 * conversion keeps a member active for a while (see membership). Converted NFTs can be sold on the
 * marketplace; putting one up for sale also places it on the public collective artwork, free. Badges are no longer
 * awarded; ones earned before stay in user_badges.
 */

// Grids from the client's spec (3: 1 x 3, 6: 2 x 3, 12: 3 x 4, 24: 4 x 6).
const OPTIONS = [
  { length: 1, label: 'Single', rows: 1, cols: 1, rarity: 'common', badge: null, nftEligible: false },
  { length: 2, label: 'Twin', rows: 1, cols: 2, rarity: 'common', badge: null, nftEligible: false },
  { length: 3, label: 'Triple', rows: 1, cols: 3, rarity: 'common', badge: null, nftEligible: true },
  { length: 6, label: 'Hexa', rows: 2, cols: 3, rarity: 'epic', badge: null, nftEligible: true },
  { length: 12, label: 'Dozen', rows: 3, cols: 4, rarity: 'mythic', badge: null, nftEligible: true },
  { length: 24, label: 'Double Dozen', rows: 4, cols: 6, rarity: 'legendary', badge: null, nftEligible: true },
];
// What converting each level's set of emblems into an NFT costs (the client's provisional prices). Prices
// are set per level, as a class, so they change together; the same values are the recommended minimum
// resale prices for now.
const CONVERSION_PRICE_CENTS = { 3: 9000, 6: 18000, 12: 54000, 24: 216000 };
const conversionPrice = (length) =>
  CONVERSION_PRICE_CENTS[length] ? { amountCents: CONVERSION_PRICE_CENTS[length], currency: env.PAYMENTS_CURRENCY } : null;
const LENGTHS = OPTIONS.map((o) => o.length);
// Explorers may read singles, twins and Level 1 (3) only; Creators and Collectors any length.
const EXPLORER_LENGTHS = [1, 2, 3];
const isExplorer = (user) => user.membershipType === 'explorer';
/** The series lengths this member may start. */
const allowedLengths = (user) => (isExplorer(user) ? EXPLORER_LENGTHS : LENGTHS);
const optionFor = (length) => OPTIONS.find((o) => o.length === length);

// The demo butterfly artworks bundled in the app (assets/collection/butterflies), for every series.
// Practice series started before singles and twins earned emblems have NO_ARTWORK. Series started before
// the butterflies keep their old artwork_N keys, which the app still maps.
const ARTWORK_COUNT = 15;
const ARTWORK_KEYS = Array.from({ length: ARTWORK_COUNT }, (_, i) => `butterfly_${String(i + 1).padStart(2, '0')}`);
const NO_ARTWORK = 'none';
// The lengths with an emblem: only these reach the collective artwork.
const EMBLEM_LENGTHS = OPTIONS.filter((o) => o.nftEligible).map((o) => o.length);


const HOUR = 60 * 60 * 1000;
const windowMs = () => env.READING_WINDOW_HOURS * HOUR;
// A series that ended without completing: its emblems stay in the gallery but it is lost.
const LOST_STATUSES = ['abandoned', 'failed'];

/** Fisher-Yates with crypto randomness: the order the tiles will be revealed in. */
function shuffledTiles(length) {
  const tiles = Array.from({ length }, (_, i) => i);
  for (let i = tiles.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles;
}

const toPublicListing = (l) => l && { id: l.id, priceCents: l.priceCents, currency: l.currency, createdAt: l.createdAt };

/**
 * What the app sees: never the reveal order, so the tiles still to come stay hidden. `listing` is its open
 * marketplace listing, if any.
 */
const toPublicSeries = (series, badges = [], listing = null) =>
  series && {
    id: series.id,
    length: series.length,
    rows: series.rows,
    cols: series.cols,
    rarity: series.rarity,
    label: optionFor(series.length)?.label ?? `${series.length}`,
    status: series.status,
    artworkKey: series.artworkKey,
    revealedTiles: series.revealedTiles,
    revealedCount: series.revealedTiles.length,
    startedAt: series.startedAt,
    lastReadingAt: series.lastReadingAt,
    deadlineAt: series.status === 'active' ? series.deadlineAt : null,
    completedAt: series.completedAt,
    failedAt: series.failedAt ?? null,
    nftEligible: Boolean(optionFor(series.length)?.nftEligible),
    badges,
    publishedAt: series.publishedAt ?? null,
    mintChoice: series.mintChoice ?? null,
    // Converted into an NFT (then it can be sold), and what converting costs.
    convertedAt: series.convertedAt ?? null,
    conversionPrice: conversionPrice(series.length),
    // Papolona's recommended minimum resale price for the level (the seller may ask more, never less).
    suggestedResalePrice: conversionPrice(series.length),
    // Bought on the marketplace rather than made by its owner.
    acquired: Boolean(series.creatorId && series.creatorId !== series.userId),
    listing: toPublicListing(listing),
  };

/** Many series for the app, each with its badges and open listing. */
async function withBadges(list) {
  const completed = list.filter((s) => s.status === 'completed').map((s) => s.id);
  const [byId, listings] = await Promise.all([db.badges.bySeries(completed), db.market.activeBySeries(completed)]);
  return list.map((s) => toPublicSeries(s, byId[s.id] ?? [], listings[s.id] ?? null));
}

const withBadgesOne = async (series) => (series ? (await withBadges([series]))[0] : null);

/** Fails the user's active series if its latest reading ran out of time. */
const failIfExpired = (userId, now) => db.series.failIfExpired(userId, now, new Date(now.getTime() - windowMs()));

/** The user's active series, after failing it if its latest reading ran out of time. */
async function findActive(userId, now = new Date()) {
  await failIfExpired(userId, now);
  return db.series.findActive(userId);
}

/** The series picker: the lengths, their grids, rarities and rewards. */
function options() {
  return OPTIONS.map((o) => ({ ...o, minDays: o.length }));
}

/**
 * Publishing is free now (an NFT put up for sale joins the collective artwork by itself). price stays, at
 * zero, for app builds that still show it; demoPayments says whether demo payments are on.
 */
const publishInfo = () => ({
  price: { amountCents: 0, currency: env.PAYMENTS_CURRENCY },
  free: true,
  demoPayments: env.DEMO_PAYMENTS,
});

async function getActive(userId) {
  return toPublicSeries(await findActive(userId));
}

/**
 * Active and completed series, newest first, and abandoned or failed series that earned emblems: the
 * member keeps those emblems in the gallery, but an unfinished series can never be converted into an NFT.
 */
async function list(userId) {
  await failIfExpired(userId, new Date());
  const all = await db.series.list(userId);
  return withBadges(
    all.filter(
      (s) => !LOST_STATUSES.includes(s.status) || (s.artworkKey !== NO_ARTWORK && s.revealedTiles.length > 0),
    ),
  );
}

/** Starts a series of `length` readings. Members only, one at a time. */
async function start(signedIn, { length }, now = new Date()) {
  // A Creator or Collector who missed their terms is an Explorer from here on.
  const { user } = await standing.enforce(signedIn, now);
  if (user.status !== 'member') {
    throw ApiError.forbidden('MEMBERSHIP_REQUIRED', 'Finish probation and join the collective to start a series.');
  }
  const option = optionFor(length);
  if (!option) throw ApiError.badRequest('INVALID_SERIES_LENGTH', `Choose ${LENGTHS.join(', ')} readings.`);
  if (!allowedLengths(user).includes(length)) {
    throw ApiError.forbidden(
      'LEVEL_NOT_ALLOWED',
      'Explorers can read singles, twins and Level 1 series. Upgrade to Creator or Collector for the other levels.',
    );
  }

  if (await findActive(user.id, now)) {
    throw ApiError.conflict('SERIES_ACTIVE', 'Finish your current series before starting another.');
  }

  try {
    const series = await db.series.create(user.id, {
      length: option.length,
      rows: option.rows,
      cols: option.cols,
      rarity: option.rarity,
      artworkKey: ARTWORK_KEYS[crypto.randomInt(ARTWORK_KEYS.length)],
      revealOrder: shuffledTiles(option.length),
      startedAt: now,
      // Set again as each reading is drawn: that reading's deadline.
      deadlineAt: new Date(now.getTime() + windowMs()),
    });
    return toPublicSeries(series);
  } catch (err) {
    // A second request started one first.
    if (err instanceof DuplicateError) {
      throw ApiError.conflict('SERIES_ACTIVE', 'Finish your current series before starting another.');
    }
    throw err;
  }
}

/**
 * Called as a clue is drawn: the active series the new reading belongs to (abandoning a late one first),
 * or null. Call recordDraw once the draw is saved.
 */
const seriesForNewDraw = (userId, now) => findActive(userId, now);

/** The draw was saved in the series: it must be completed within the window. */
async function recordDraw(seriesId, { at }) {
  const updated = await db.series.recordDraw(seriesId, { at, deadlineAt: new Date(at.getTime() + windowMs()) });
  return toPublicSeries(updated);
}

/**
 * Called once a reading is judged. A pass in an active series reveals its next tile. A fail that used the
 * reading's last attempt (`outOfAttempts`) fails a member's active series. Resolves to { series, tileIndex }
 * for the app (series null when the reading wasn't in one; tileIndex null when nothing was revealed).
 */
async function onJudged(userId, draw, { outOfAttempts = false, member = false } = {}, now = new Date()) {
  if (!draw.seriesId) return { series: null, tileIndex: null };
  if (draw.interpretation?.verdict === 'pass') {
    const revealed = await db.series.revealNext(draw.seriesId, draw.id, now);
    if (revealed) return { series: await withBadgesOne(revealed.series), tileIndex: revealed.tileIndex };
  } else if (outOfAttempts && member) {
    const failed = await db.series.fail(draw.seriesId, now);
    if (failed) return { series: await withBadgesOne(failed), tileIndex: null };
  }
  return { series: await withBadgesOne(await db.series.findById(userId, draw.seriesId)), tileIndex: null };
}

/** The user's own series, or 404. */
async function ownSeries(userId, id) {
  const series = await db.series.findById(userId, id);
  if (!series) throw ApiError.notFound('SERIES_NOT_FOUND', 'Series not found.');
  return series;
}

const toPayment = (p) => ({
  id: p.id,
  purpose: p.purpose,
  amountCents: p.amountCents,
  currency: p.currency,
  provider: p.provider,
  status: p.status,
  createdAt: p.createdAt,
});

/**
 * Places a completed emblem series on the collective artwork, free. Its readings' meanings become visible
 * to everyone. Putting an NFT up for sale does this by itself; app builds from before still call it.
 * Resolves to { series, payment: null }.
 */
async function publish(user, id, now = new Date()) {
  const series = await ownSeries(user.id, id);
  if (series.status !== 'completed') {
    throw ApiError.conflict('SERIES_NOT_COMPLETED', 'Complete the series before publishing it.');
  }
  if (!optionFor(series.length)?.nftEligible) {
    throw ApiError.forbidden('NOT_PUBLISHABLE', 'Only Triple, Hexa, Dozen and Double Dozen series join the collective artwork.');
  }
  if (series.publishedAt) throw ApiError.conflict('ALREADY_PUBLISHED', 'This series is already published.');
  const result = await db.series.publish(user.id, id, now);
  if (!result) throw ApiError.conflict('ALREADY_PUBLISHED', 'This series is already published.');
  return { series: await withBadgesOne(result.series), payment: null };
}

/**
 * Makes a series private again: off the collective artwork, its readings' meanings no longer shown. Not
 * while it is up for sale (409 LISTED_FOR_SALE): selling keeps it public. Already private is a no-op.
 * Resolves to { series }.
 */
async function unpublish(user, id, now = new Date()) {
  const series = await ownSeries(user.id, id);
  if (!series.publishedAt) return { series: await withBadgesOne(series) };
  const listing = (await db.market.activeBySeries([id]))[id];
  if (listing) {
    throw ApiError.conflict('LISTED_FOR_SALE', 'A series for sale stays on the collective artwork. Withdraw it from sale first.');
  }
  const result = await db.series.unpublish(user.id, id, now);
  // Listed in the meantime: still public.
  if (!result) {
    const current = await ownSeries(user.id, id);
    if (current.publishedAt) {
      throw ApiError.conflict('LISTED_FOR_SALE', 'A series for sale stays on the collective artwork. Withdraw it from sale first.');
    }
    return { series: await withBadgesOne(current) };
  }
  return { series: await withBadgesOne(result.series) };
}

/** The user's completed emblem series, or the reason it can't be converted. */
async function convertible(signedIn, id) {
  const { user } = await standing.enforce(signedIn);
  if (isExplorer(user)) {
    throw ApiError.forbidden(
      'EXPLORER_CANNOT_PROFIT',
      'Explorers cannot convert emblems into NFTs. Upgrade to Creator or Collector to convert and sell.',
    );
  }
  const series = await ownSeries(user.id, id);
  if (series.status !== 'completed') throw ApiError.conflict('SERIES_NOT_COMPLETED', 'Complete the series first.');
  if (!optionFor(series.length)?.nftEligible) {
    throw ApiError.forbidden('NOT_MINT_ELIGIBLE', 'Only Triple, Hexa, Dozen and Double Dozen series can be converted into NFTs.');
  }
  return series;
}

/**
 * Converts a completed emblem series into an NFT for its conversion price (demo payments only for now),
 * with or without joining the POC ecosystem. Keeps the member active (see membership). Resolves to
 * { series, payment }.
 */
async function convert(user, id, { poc = false } = {}, now = new Date()) {
  const series = await convertible(user, id);
  if (series.convertedAt) throw ApiError.conflict('ALREADY_CONVERTED', 'This emblem is already an NFT.');
  if (!env.DEMO_PAYMENTS) throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not available yet.');
  const result = await db.series.convert(
    user.id,
    id,
    poc ? 'mint_poc' : 'mint',
    {
      ...conversionPrice(series.length),
      provider: 'demo',
      providerRef: `demo_${crypto.randomUUID()}`,
      billing: await billingService.snapshot(user.id),
    },
    now,
  );
  // A second request converted it first: nothing was charged twice.
  if (!result) throw ApiError.conflict('ALREADY_CONVERTED', 'This emblem is already an NFT.');
  return { series: await withBadgesOne(result.series), payment: toPayment(result.payment) };
}

/**
 * Records what the member wants for an emblem: 'keep' it in the gallery, or 'mint' / 'mint_poc', which
 * converts it (paid, see convert). A converted emblem stays an NFT.
 */
async function setMintChoice(user, id, choice, now = new Date()) {
  if (choice !== 'keep') return (await convert(user, id, { poc: choice === 'mint_poc' }, now)).series;
  const series = await convertible(user, id);
  if (series.convertedAt) throw ApiError.conflict('ALREADY_CONVERTED', 'This emblem is already an NFT.');
  return withBadgesOne(await db.series.setMintChoice(user.id, id, choice, now));
}

module.exports = {
  OPTIONS,
  allowedLengths,
  isExplorer,
  ARTWORK_KEYS,
  NO_ARTWORK,
  EMBLEM_LENGTHS,
  options,
  publishInfo,
  publish,
  unpublish,
  setMintChoice,
  convert,
  conversionPrice,
  withBadges,
  ownSeries,
  toPayment,
  getActive,
  list,
  start,
  seriesForNewDraw,
  recordDraw,
  onJudged,
  toPublicSeries,
  shuffledTiles,
};
