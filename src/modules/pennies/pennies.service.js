const crypto = require('crypto');
const env = require('../../config/env');
const db = require('../../db');
const billingService = require('../billing/billing.service');
const ApiError = require('../../utils/ApiError');
const { startOfUtcDay } = require('../../db/postgres/pennies');

/**
 * Papolona pennies: the app's own currency. 1 penny = 1 cent. Every new user starts with 1,000; a daily
 * bonus adds a few; selling an NFT pays the seller's share in pennies. Everything in the app is paid in
 * pennies: readings, AI clue suggestions, message requests, conversions, NFTs (bids hold the pennies until
 * outbid), memberships, the Collector fee, the Sensitisation Package and donations. Penny packs are the
 * one thing bought with real money (demo payments only for now; inside the iOS and Android apps they will
 * have to go through the stores' in-app purchases).
 */

// What every everyday action costs, in pennies.
const prices = () => ({
  reading: env.PENNY_READING_PRICE,
  cluePrompt: env.PENNY_PROMPT_PRICE,
  messageRequest: env.PENNY_MESSAGE_REQUEST_PRICE,
});

// Penny packs, for real money: the bigger ones add a bonus.
const PACKS = [
  { id: 'pack_1000', pennies: 1000, priceCents: 1000 },
  { id: 'pack_5500', pennies: 5500, priceCents: 5000, bonusPercent: 10 },
  { id: 'pack_12000', pennies: 12000, priceCents: 10000, bonusPercent: 20 },
];
const listPacks = () => PACKS.map((p) => ({ bonusPercent: 0, ...p, currency: env.PENNY_PACK_CURRENCY }));

const DAY = 24 * 60 * 60 * 1000;

/** Whether the daily bonus can be claimed now, and when the next one can if not. */
const bonusStatus = (user, now = new Date()) => {
  const today = startOfUtcDay(now);
  const available = !user.dailyBonusAt || new Date(user.dailyBonusAt) < today;
  return {
    amount: env.PENNY_DAILY_BONUS,
    available: available && env.PENNY_DAILY_BONUS > 0,
    nextAt: available ? null : new Date(today.getTime() + DAY),
  };
};

/** The wallet: { balance, dailyBonus, prices, packs, demoPayments }. */
async function getWallet(signedIn, now = new Date()) {
  const user = (await db.users.findById(signedIn.id)) ?? signedIn;
  return {
    balance: user.walletCents ?? 0,
    dailyBonus: bonusStatus(user, now),
    prices: prices(),
    packs: listPacks(),
    demoPayments: env.DEMO_PAYMENTS,
  };
}

/** The penny history, newest first: { transactions, nextBefore }. */
async function history(user, { before = null, limit = 30 } = {}) {
  const transactions = await db.pennies.history(user.id, { before, limit });
  return {
    transactions,
    nextBefore: transactions.length === limit ? transactions[transactions.length - 1].createdAt : null,
  };
}

/** Claims today's bonus. Resolves to { wallet, claimed }; 409 when it was already claimed today. */
async function claimDailyBonus(user, now = new Date()) {
  if (env.PENNY_DAILY_BONUS <= 0) throw ApiError.conflict('NO_DAILY_BONUS', 'There is no daily bonus right now.');
  const balance = await db.pennies.claimDailyBonus(user.id, env.PENNY_DAILY_BONUS, now);
  if (balance === null) {
    throw ApiError.conflict('BONUS_ALREADY_CLAIMED', 'You have claimed today’s pennies. Come back tomorrow.');
  }
  return { claimed: env.PENNY_DAILY_BONUS, wallet: await getWallet(user, now) };
}

/** Buys a penny pack with real money (demo payments only for now). Resolves to { wallet, payment }. */
async function buyPack(user, packId, now = new Date()) {
  const pack = PACKS.find((p) => p.id === packId);
  if (!pack) throw ApiError.badRequest('UNKNOWN_PACK', 'This penny pack is not on offer.');
  if (!env.DEMO_PAYMENTS) throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not available yet.');
  const { payment } = await db.pennies.buyPack(
    user.id,
    pack.pennies,
    {
      amountCents: pack.priceCents,
      currency: env.PENNY_PACK_CURRENCY,
      provider: 'demo',
      providerRef: `demo_${crypto.randomUUID()}`,
      billing: await billingService.snapshot(user.id),
    },
    now,
  );
  return {
    wallet: await getWallet(user, now),
    payment: { id: payment.id, amountCents: payment.amountCents, currency: payment.currency, createdAt: payment.createdAt },
  };
}

/**
 * Charges an everyday action's price and runs `action`; when the action fails, the pennies are given
 * back. Free (price 0) actions just run.
 */
async function chargeFor(userId, amount, reason, action) {
  if (!amount) return action();
  await db.pennies.spend(userId, amount, reason);
  try {
    return await action();
  } catch (err) {
    await db.pennies.credit(userId, amount, 'refund');
    throw err;
  }
}

module.exports = { getWallet, history, claimDailyBonus, buyPack, chargeFor, prices, listPacks, PACKS };
