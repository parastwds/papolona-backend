const crypto = require('crypto');
const env = require('../../config/env');
const db = require('../../db');
const billingService = require('../billing/billing.service');
const { DuplicateError } = require('../../db/errors');
const ApiError = require('../../utils/ApiError');
const { publicName } = require('../artwork/artwork.service');
const membership = require('../membership/membership.service');
const series = require('../series/series.service');
const standing = require('../membership/standing');

/**
 * The marketplace: active members sell the NFTs they own (converted emblems, their own or bought) at a
 * price they set; anyone signed in can buy, apprentices and members who are not active included. A sale
 * moves the NFT to the buyer; Papolona keeps MARKET_FEE_PERCENT and the seller gets the rest. Demo
 * payments only for now: nobody is charged and nothing is paid out.
 */

// $1 to $100,000.
const MIN_PRICE_CENTS = 100;
const MAX_PRICE_CENTS = 10_000_000;

/** A listing for the app: the NFT, its seller's public name, and (for the seller) the split. */
function toPublicOffer(offer, viewerId) {
  const mine = offer.sellerId === viewerId;
  const feeCents = offer.feeCents ?? Math.round((offer.priceCents * env.MARKET_FEE_PERCENT) / 100);
  return {
    id: offer.id,
    priceCents: offer.priceCents,
    currency: offer.currency,
    status: offer.status,
    createdAt: offer.createdAt,
    soldAt: offer.soldAt,
    seller: { id: offer.sellerId, name: publicName(offer.sellerName) },
    mine,
    // What the seller gets, what Papolona keeps and who bought it: shown to the seller only.
    ...(mine && {
      feeCents,
      sellerProceedsCents: offer.sellerProceedsCents ?? offer.priceCents - feeCents,
      buyer: offer.buyerId ? { id: offer.buyerId, name: publicName(offer.buyerName ?? '') } : null,
    }),
    series: series.toPublicSeries(offer.series),
  };
}

/** A page of open listings, newest first: { listings, nextBefore } (null on the last page). */
async function list(user, { before = null, limit = 30 } = {}) {
  const offers = await db.market.listActive({ before, limit });
  return {
    listings: offers.map((o) => toPublicOffer(o, user.id)),
    nextBefore: offers.length === limit ? offers[offers.length - 1].createdAt : null,
    feePercent: env.MARKET_FEE_PERCENT,
  };
}

async function findOffer(id) {
  const offer = await db.market.findOffer(id);
  if (!offer) throw ApiError.notFound('LISTING_NOT_FOUND', 'Listing not found.');
  return offer;
}

/** One listing, open or not: { listing }. */
async function get(user, id) {
  return { listing: toPublicOffer(await findOffer(id), user.id) };
}

/** The user's listings as a seller, open and closed, newest first: { listings }. */
async function mine(user) {
  const offers = await db.market.listBySeller(user.id);
  return { listings: offers.map((o) => toPublicOffer(o, user.id)), feePercent: env.MARKET_FEE_PERCENT };
}

/** Puts one of the user's NFTs up for sale at `priceCents`. Active members only. Resolves to { listing }. */
async function create(signedIn, { seriesId, priceCents }) {
  const { user } = await standing.enforce(signedIn);
  if (series.isExplorer(user)) {
    throw ApiError.forbidden(
      'EXPLORER_CANNOT_PROFIT',
      'Explorers cannot sell NFTs. Upgrade to Creator or Collector to sell.',
    );
  }
  const owned = await series.ownSeries(user.id, seriesId);
  if (!owned.convertedAt) {
    throw ApiError.forbidden('NOT_AN_NFT', 'Convert this emblem into an NFT before selling it.');
  }
  if (!(await membership.activeStatus(user)).isActive) {
    throw ApiError.forbidden(
      'ACTIVE_MEMBERSHIP_REQUIRED',
      'Only active members can sell: order the meditation stone and convert an emblem to become active.',
    );
  }
  if (priceCents < MIN_PRICE_CENTS || priceCents > MAX_PRICE_CENTS) {
    throw ApiError.badRequest('INVALID_PRICE', 'Choose a price between $1 and $100,000.');
  }
  // The seller may negotiate the price, provided it is no lower than Papolona's suggested minimum for the level.
  const suggested = series.conversionPrice(owned.length);
  if (suggested && priceCents < suggested.amountCents) {
    throw ApiError.badRequest(
      'BELOW_SUGGESTED_PRICE',
      `Choose a price of at least $${(suggested.amountCents / 100).toLocaleString('en-US')}, Papolona's suggested minimum for this level.`,
      { suggestedResalePrice: suggested },
    );
  }
  try {
    const listing = await db.market.create({
      seriesId,
      sellerId: user.id,
      priceCents,
      currency: env.PAYMENTS_CURRENCY,
    });
    return get(user, listing.id);
  } catch (err) {
    if (err instanceof DuplicateError) throw ApiError.conflict('ALREADY_LISTED', 'This NFT is already for sale.');
    throw err;
  }
}

/** Takes the user's open listing off the marketplace. Resolves to { listing }. */
async function cancel(user, id) {
  const offer = await findOffer(id);
  if (offer.sellerId !== user.id) throw ApiError.notFound('LISTING_NOT_FOUND', 'Listing not found.');
  if (!(await db.market.cancel(user.id, id))) {
    throw ApiError.conflict('LISTING_CLOSED', 'This listing is no longer for sale.');
  }
  return get(user, id);
}

/**
 * Buys an open listing (demo payment): the NFT moves to the buyer. Not one's own. Resolves to
 * { listing, series, payment }.
 */
async function buy(user, id, now = new Date()) {
  const offer = await findOffer(id);
  if (offer.sellerId === user.id) throw ApiError.conflict('OWN_LISTING', 'This is your own listing.');
  if (offer.status !== 'active') throw ApiError.conflict('LISTING_CLOSED', 'This NFT is no longer for sale.');
  if (!env.DEMO_PAYMENTS) throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not available yet.');

  const result = await db.market.buy(
    user.id,
    id,
    { feePercent: env.MARKET_FEE_PERCENT, payment: {
        provider: 'demo',
        providerRef: `demo_${crypto.randomUUID()}`,
        billing: await billingService.snapshot(user.id),
      },
    },
    now,
  );
  // Someone else bought it first, or the seller withdrew it: nothing was charged.
  if (!result) throw ApiError.conflict('LISTING_CLOSED', 'This NFT is no longer for sale.');
  return {
    listing: (await get(user, id)).listing,
    series: (await series.withBadges([result.series]))[0],
    payment: series.toPayment(result.payment),
  };
}

module.exports = { list, get, mine, create, cancel, buy, MIN_PRICE_CENTS, MAX_PRICE_CENTS };
