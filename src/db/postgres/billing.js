const { eq } = require('drizzle-orm');
const { db } = require('./connection');
const { billingProfiles: B } = require('./schema');

const toBilling = (row) =>
  row && {
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    postcode: row.postcode,
    country: row.country,
    updatedAt: row.updatedAt,
  };

const billing = {
  /** The user's billing info, or null when they have not saved any. */
  async find(userId) {
    const [row] = await db().select().from(B).where(eq(B.userId, userId));
    return toBilling(row ?? null);
  },

  /** Saves (creates or replaces) the user's billing info. Resolves to it. */
  async save(userId, info) {
    const values = { ...info, updatedAt: new Date() };
    const [row] = await db()
      .insert(B)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: B.userId, set: values })
      .returning();
    return toBilling(row);
  },
};

module.exports = { billing };
