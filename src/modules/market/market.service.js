const crypto = require('crypto');
const env = require('../../config/env');
const db = require('../../db');
const billingService = require('../billing/billing.service');
const { DuplicateError } = require('../../db/errors');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { sendMail } = require('../../utils/mailer');
const { publicName } = require('../artwork/artwork.service');
const membership = require('../membership/membership.service');
const series = require('../series/series.service');
const standing = require('../membership/standing');

/**
 * The marketplace: active members sell the NFTs they own (converted emblems, their own or bought).
 * Papolona is the seller's agent and offers each NFT to Collectors first:
 * - Collectors' auction: for AUCTION_COLLECTOR_DAYS (90) after listing, only Collector members see the NFT
 *   and bid on it, from the seller's starting price (at least Papolona's suggested minimum). Each bid must
 *   beat the highest so far. When the days are up the highest bidder wins and pays their bid.
 * - Open to all: with no bids by then, anyone signed in can buy it at the starting price, apprentices and
 *   members who are not active included.
 * Papolona keeps MARKET_FEE_PERCENT of each sale and the seller gets the rest. Demo payments only for now:
 * nobody is charged and nothing is paid out. The seller can withdraw a listing only while it has no bids.
 */

// $1 to $100,000.
const MIN_PRICE_CENTS = 100;
const MAX_PRICE_CENTS = 10_000_000;
const DAY = 24 * 60 * 60 * 1000;

const isCollector = (user) => user.status === 'member' && user.membershipType === 'collector';

/** The least the next bid may be once the highest is `highestCents`: AUCTION_MIN_INCREMENT_PERCENT more, and $1 more at least. */
const minNextBid = (highestCents) =>
  highestCents + Math.max(100, Math.ceil((highestCents * env.AUCTION_MIN_INCREMENT_PERCENT) / 100));

const formatMoney = (cents, currency) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

/**
 * Where a listing stands in its sale: { phase: 'collectors' | 'open', collectorsUntil, bidCount,
 * highestBidCents, minNextBidCents, highestBidMine, canBid, canBuy }. The highest bidder is named to the
 * seller only.
 */
function auctionOf(offer, bids, viewer, now) {
  const mine = offer.sellerId === viewer.id;
  const inAuction = offer.status === 'active' && !!offer.collectorsUntil && new Date(offer.collectorsUntil) > now;
  const highestCents = bids?.highestCents ?? null;
  const highestBidMine = !!bids && bids.highestBidderId === viewer.id;
  return {
    phase: inAuction ? 'collectors' : 'open',
    collectorsUntil: offer.collectorsUntil,
    bidCount: bids?.count ?? 0,
    highestBidCents: highestCents,
    minNextBidCents: highestCents === null ? offer.priceCents : minNextBid(highestCents),
    highestBidMine,
    ...(mine && bids && { highestBidder: { id: bids.highestBidderId, name: publicName(bids.highestBidderName) } }),
    canBid: inAuction && !mine && !highestBidMine && isCollector(viewer),
    canBuy: offer.status === 'active' && !inAuction && !bids && !mine,
  };
}

/** A listing for the app: the NFT, its seller's public name, its auction and (for the seller) the split. */
function toPublicOffer(offer, viewer, bids = null, now = new Date()) {
  const mine = offer.sellerId === viewer.id;
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
    auction: auctionOf(offer, bids, viewer, now),
    // What the seller gets, what Papolona keeps and who bought it: shown to the seller only.
    ...(mine && {
      feeCents,
      sellerProceedsCents: offer.sellerProceedsCents ?? offer.priceCents - feeCents,
      buyer: offer.buyerId ? { id: offer.buyerId, name: publicName(offer.buyerName ?? '') } : null,
    }),
    series: series.toPublicSeries(offer.series),
  };
}

/** Listings for the app, each with its bids. */
async function toPublicOffers(offers, viewer, now = new Date()) {
  const bids = await db.market.bidSummaries(offers.map((o) => o.id));
  return offers.map((o) => toPublicOffer(o, viewer, bids[o.id] ?? null, now));
}

/** Emails the winner and the seller once an auction is settled. A failed email is logged, not thrown. */
async function announceSale(listing, winnerId) {
  const [winner, seller] = await Promise.all([db.users.findById(winnerId), db.users.findById(listing.sellerId)]);
  const price = formatMoney(listing.priceCents, listing.currency);
  const mails = [
    winner && {
      to: winner.email,
      subject: 'You won a Papolona auction',
      text: `Hello ${winner.name},\n\nYour bid of ${price} was the highest when the Collectors' auction closed. The NFT is now yours and waits in your Gallery.\n\nPapolona`,
    },
    seller && {
      to: seller.email,
      subject: 'Your NFT has sold at auction',
      text: `Hello ${seller.name},\n\nYour NFT sold to a Collector for ${price} when its auction closed. Your share is ${formatMoney(
        listing.sellerProceedsCents,
        listing.currency,
      )}.\n\nPapolona, your agent`,
    },
  ].filter(Boolean);
  for (const mail of mails) {
    try {
      await sendMail(mail);
    } catch (err) {
      logger.error(`Auction email for listing ${listing.id} failed`, err.message);
    }
  }
}

/**
 * Settles Collectors' auctions that have ended with bids: each NFT goes to its highest bidder (demo
 * payment) and both sides are emailed. `ids` limits it to those listings. Run every minute by the
 * dispatcher, and before a listing is read or bought so a closed auction never shows as open.
 * Resolves to the number settled.
 */
async function settleDueAuctions(now = new Date(), ids = null) {
  if (!env.DEMO_PAYMENTS) return 0;
  const due = (await db.market.dueAuctions(now)).filter((d) => !ids || ids.includes(d.id));
  let settled = 0;
  for (const { id, winnerId } of due) {
    const result = await db.market.settleAuction(
      id,
      {
        feePercent: env.MARKET_FEE_PERCENT,
        payment: {
          provider: 'demo',
          providerRef: `demo_${crypto.randomUUID()}`,
          billing: await billingService.snapshot(winnerId),
        },
      },
      now,
    );
    if (!result) continue;
    settled += 1;
    await announceSale(result.listing, result.winnerId);
  }
  if (settled > 0) logger.info(`Auctions settled: ${settled}`);
  return settled;
}

/**
 * A page of open listings, newest first: { listings, nextBefore } (null on the last page). Collectors also
 * see the NFTs in their Collectors' auction; everyone else only those open to all.
 */
async function list(user, { before = null, limit = 30 } = {}, now = new Date()) {
  await settleDueAuctions(now);
  const offers = await db.market.listActive({ before, limit, collectors: isCollector(user), now });
  return {
    listings: await toPublicOffers(offers, user, now),
    nextBefore: offers.length === limit ? offers[offers.length - 1].createdAt : null,
    feePercent: env.MARKET_FEE_PERCENT,
    auctionDays: env.AUCTION_COLLECTOR_DAYS,
  };
}

async function findOffer(id) {
  const offer = await db.market.findOffer(id);
  if (!offer) throw ApiError.notFound('LISTING_NOT_FOUND', 'Listing not found.');
  return offer;
}

/**
 * One listing, open or not: { listing }. One still in its Collectors' auction is shown to Collectors and
 * its seller only.
 */
async function get(user, id, now = new Date()) {
  await settleDueAuctions(now, [id]);
  const offer = await findOffer(id);
  const [listing] = await toPublicOffers([offer], user, now);
  if (listing.auction.phase === 'collectors' && !listing.mine && !isCollector(user)) {
    throw ApiError.notFound('LISTING_NOT_FOUND', 'Listing not found.');
  }
  return { listing };
}

/** The user's listings as a seller, open and closed, newest first: { listings }. */
async function mine(user, now = new Date()) {
  await settleDueAuctions(now);
  const offers = await db.market.listBySeller(user.id);
  return {
    listings: await toPublicOffers(offers, user, now),
    feePercent: env.MARKET_FEE_PERCENT,
    auctionDays: env.AUCTION_COLLECTOR_DAYS,
  };
}

/**
 * Puts one of the user's NFTs up for sale from a starting price of `priceCents`: first as a Collectors'
 * auction for AUCTION_COLLECTOR_DAYS, then (without bids) open to all at that price. Active members only.
 * Resolves to { listing }.
 */
async function create(signedIn, { seriesId, priceCents }, now = new Date()) {
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
    const listing = await db.market.create(
      {
        seriesId,
        sellerId: user.id,
        priceCents,
        currency: env.PAYMENTS_CURRENCY,
        collectorsUntil: new Date(now.getTime() + env.AUCTION_COLLECTOR_DAYS * DAY),
      },
      now,
    );
    return get(user, listing.id, now);
  } catch (err) {
    if (err instanceof DuplicateError) throw ApiError.conflict('ALREADY_LISTED', 'This NFT is already for sale.');
    throw err;
  }
}

/** Takes the user's open listing off the marketplace, while no Collector has bid on it. Resolves to { listing }. */
async function cancel(user, id) {
  const offer = await findOffer(id);
  if (offer.sellerId !== user.id) throw ApiError.notFound('LISTING_NOT_FOUND', 'Listing not found.');
  const result = await db.market.cancel(user.id, id);
  if (!result) throw ApiError.conflict('LISTING_CLOSED', 'This listing is no longer for sale.');
  if (result.error === 'HAS_BIDS') {
    throw ApiError.conflict('HAS_BIDS', 'Collectors have bid on this NFT: it stays in the auction until it closes.');
  }
  return get(user, id);
}

/**
 * A Collector's bid on a listing in its Collectors' auction. Resolves to { listing }. Refused with
 * COLLECTORS_ONLY, OWN_LISTING, AUCTION_ENDED, LISTING_CLOSED, ALREADY_HIGHEST or BID_TOO_LOW (with the
 * least bid allowed).
 */
async function bid(signedIn, id, { amountCents }, now = new Date()) {
  const { user } = await standing.enforce(signedIn);
  const offer = await findOffer(id);
  if (offer.sellerId === user.id) throw ApiError.conflict('OWN_LISTING', 'This is your own listing.');
  if (!isCollector(user)) {
    throw ApiError.forbidden('COLLECTORS_ONLY', 'Only Collector members can bid in the Collectors’ auction.');
  }
  if (!Number.isInteger(amountCents) || amountCents > MAX_PRICE_CENTS) {
    throw ApiError.badRequest('INVALID_PRICE', 'Choose a bid between $1 and $100,000.');
  }
  const result = await db.market.placeBid(id, user.id, amountCents, minNextBid, now);
  switch (result.error) {
    case undefined:
      return get(user, id, now);
    case 'CLOSED':
      throw ApiError.conflict('LISTING_CLOSED', 'This NFT is no longer for sale.');
    case 'ENDED':
      throw ApiError.conflict('AUCTION_ENDED', 'The Collectors’ auction for this NFT has closed.');
    case 'OWN_LISTING':
      throw ApiError.conflict('OWN_LISTING', 'This is your own listing.');
    case 'ALREADY_HIGHEST':
      throw ApiError.conflict('ALREADY_HIGHEST', 'You already have the highest bid.');
    default:
      throw ApiError.badRequest(
        'BID_TOO_LOW',
        `Bid at least ${formatMoney(result.minCents, offer.currency)}.`,
        { minBidCents: result.minCents },
      );
  }
}

/**
 * Buys an open listing (demo payment) once its Collectors' auction has closed without bids: the NFT moves
 * to the buyer. Not one's own. Resolves to { listing, series, payment }.
 */
async function buy(user, id, now = new Date()) {
  await settleDueAuctions(now, [id]);
  const offer = await findOffer(id);
  if (offer.sellerId === user.id) throw ApiError.conflict('OWN_LISTING', 'This is your own listing.');
  if (offer.status !== 'active') throw ApiError.conflict('LISTING_CLOSED', 'This NFT is no longer for sale.');
  if (offer.collectorsUntil && new Date(offer.collectorsUntil) > now) {
    throw ApiError.conflict('IN_AUCTION', 'This NFT is in the Collectors’ auction: Collectors bid on it until it closes.');
  }
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
    listing: (await get(user, id, now)).listing,
    series: (await series.withBadges([result.series]))[0],
    payment: series.toPayment(result.payment),
  };
}

module.exports = {
  list,
  get,
  mine,
  create,
  cancel,
  bid,
  buy,
  settleDueAuctions,
  minNextBid,
  MIN_PRICE_CENTS,
  MAX_PRICE_CENTS,
};
