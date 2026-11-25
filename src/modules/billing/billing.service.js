const db = require('../../db');

/**
 * Billing info: who pays, set once in Settings. The app fills every payment from it (and the package's
 * postal address), and each payment keeps a copy of it as it was when paid, for receipts.
 */

/** GET /users/me/billing: { billing } (null before it is saved) and { suggested } from the account. */
async function get(user) {
  const billing = await db.billing.find(user.id);
  return {
    billing,
    suggested: { fullName: user.name ?? '', email: user.email ?? '', phone: user.phone ?? '' },
  };
}

/** Saves the user's billing info. Resolves to { billing }. */
async function save(user, info) {
  return { billing: await db.billing.save(user.id, info) };
}

/** The billing info to keep on a payment: the saved profile without its timestamp, or null. */
async function snapshot(userId) {
  const billing = await db.billing.find(userId);
  if (!billing) return null;
  const { updatedAt, ...info } = billing;
  return info;
}

module.exports = { get, save, snapshot };
