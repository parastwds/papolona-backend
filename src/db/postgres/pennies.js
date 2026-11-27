const { and, desc, eq, isNull, lt, or, sql } = require('drizzle-orm');
const { db } = require('./connection');
const { payments: P, pennyTransactions: T, users: U } = require('./schema');
const ApiError = require('../../utils/ApiError');

/**
 * Papolona pennies: each user's balance (users.wallet_cents) and every change to it (penny_transactions).
 * A spend never takes a balance below zero: it fails with 402 NOT_ENOUGH_PENNIES instead, rolling back
 * the transaction it was part of. The *In functions run inside a caller's transaction, so a purchase and
 * what it buys are saved together or not at all.
 */

const toTransaction = (row) =>
  row && {
    id: row.id,
    amount: row.amount,
    reason: row.reason,
    refId: row.refId ?? null,
    balanceAfter: row.balanceAfter,
    createdAt: row.createdAt,
  };

const notEnough = (needed, balance) =>
  new ApiError(402, 'NOT_ENOUGH_PENNIES', `This needs ${needed.toLocaleString('en-US')} pennies; you have ${balance.toLocaleString('en-US')}.`, {
    needed,
    balance,
  });

/** Takes `amount` pennies from the user within `tx`. Resolves to the new balance; throws when short. */
async function spendIn(tx, userId, amount, reason, refId = null, now = new Date()) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`Invalid penny amount: ${amount}`);
  const [row] = await tx
    .update(U)
    .set({ walletCents: sql`${U.walletCents} - ${amount}`, updatedAt: now })
    .where(and(eq(U.id, userId), sql`${U.walletCents} >= ${amount}`))
    .returning({ balance: U.walletCents });
  if (!row) {
    const [current] = await tx.select({ balance: U.walletCents }).from(U).where(eq(U.id, userId));
    throw notEnough(amount, current?.balance ?? 0);
  }
  await tx.insert(T).values({ userId, amount: -amount, reason, refId, balanceAfter: row.balance, createdAt: now });
  return row.balance;
}

/** Gives `amount` pennies to the user within `tx`. Resolves to the new balance. */
async function creditIn(tx, userId, amount, reason, refId = null, now = new Date()) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`Invalid penny amount: ${amount}`);
  const [row] = await tx
    .update(U)
    .set({ walletCents: sql`${U.walletCents} + ${amount}`, updatedAt: now })
    .where(eq(U.id, userId))
    .returning({ balance: U.walletCents });
  if (!row) return null;
  await tx.insert(T).values({ userId, amount, reason, refId, balanceAfter: row.balance, createdAt: now });
  return row.balance;
}

// A payment made in pennies, recorded with the others (standing and receipts read payments by purpose).
const pennyPayment = (amount) => ({ amountCents: amount, currency: 'PNY', provider: 'pennies', providerRef: null });

const startOfUtcDay = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const pennies = {
  spendIn,
  creditIn,
  pennyPayment,

  /** Takes `amount` pennies on their own. Resolves to the new balance; throws 402 when short. */
  async spend(userId, amount, reason, refId = null, now = new Date()) {
    return db().transaction((tx) => spendIn(tx, userId, amount, reason, refId, now));
  },

  /** Gives `amount` pennies. Resolves to the new balance. */
  async credit(userId, amount, reason, refId = null, now = new Date()) {
    return db().transaction((tx) => creditIn(tx, userId, amount, reason, refId, now));
  },

  /**
   * Spends pennies and records the payment for `purpose` in one transaction. Resolves to
   * { payment, balance }; throws 402 when short.
   */
  async pay(userId, purpose, amount, reason, now = new Date()) {
    return db().transaction(async (tx) => {
      const [payment] = await tx
        .insert(P)
        .values({ userId, purpose, status: 'succeeded', createdAt: now, ...pennyPayment(amount) })
        .returning();
      // Short of pennies: this throws and the payment above is rolled back with it.
      const balance = await spendIn(tx, userId, amount, reason, payment.id, now);
      return { payment, balance };
    });
  },

  /**
   * The daily bonus: `amount` pennies, once a UTC day. Resolves to the new balance, or null when it was
   * already claimed today.
   */
  async claimDailyBonus(userId, amount, now = new Date()) {
    return db().transaction(async (tx) => {
      const claimed = await tx
        .update(U)
        .set({ dailyBonusAt: now })
        .where(and(eq(U.id, userId), or(isNull(U.dailyBonusAt), lt(U.dailyBonusAt, startOfUtcDay(now)))))
        .returning({ id: U.id });
      if (claimed.length === 0) return null;
      return creditIn(tx, userId, amount, 'daily_bonus', null, now);
    });
  },

  /**
   * A penny pack bought with real money: its payment and the pennies, together. Resolves to
   * { payment, balance }.
   */
  async buyPack(userId, pennyCount, payment, now = new Date()) {
    return db().transaction(async (tx) => {
      const [paid] = await tx
        .insert(P)
        .values({ userId, purpose: 'penny_pack', status: 'succeeded', createdAt: now, ...payment })
        .returning();
      const balance = await creditIn(tx, userId, pennyCount, 'pack', paid.id, now);
      return { payment: paid, balance };
    });
  },

  /** The user's penny history, newest first, before `before` (a createdAt) if given. */
  async history(userId, { before = null, limit = 30 } = {}) {
    const rows = await db()
      .select()
      .from(T)
      .where(and(eq(T.userId, userId), before ? lt(T.createdAt, before) : undefined))
      .orderBy(desc(T.createdAt), desc(T.id))
      .limit(limit);
    return rows.map(toTransaction);
  },
};

module.exports = { pennies, startOfUtcDay, spendIn, creditIn, pennyPayment };
