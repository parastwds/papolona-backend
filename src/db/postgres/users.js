const { and, eq, ne, inArray, sql } = require('drizzle-orm');
const { db } = require('./connection');
const { users: U, userIdentities: I } = require('./schema');
const { translateDuplicate, pickColumns } = require('./shared');
const { countryOfPhone } = require('../../utils/phoneCountry');

const TOP_LEVEL = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  passwordHash: 'passwordHash',
  role: 'role',
  status: 'status',
  emailVerifiedAt: 'emailVerifiedAt',
  cohort: 'cohort',
  readinessTier: 'readinessTier',
  segmentTags: 'segmentTags',
  questionnaireSubmission: 'questionnaireSubmissionId',
  memberSince: 'memberSince',
  membershipType: 'membershipType',
  membershipTypeSince: 'membershipTypeSince',
  walletCents: 'walletCents',
  failedLoginAttempts: 'failedLoginAttempts',
  lockUntil: 'lockUntil',
  passwordChangedAt: 'passwordChangedAt',
  lastLoginAt: 'lastLoginAt',
  deletedAt: 'deletedAt',
  readingReminderSentOn: 'readingReminderSentOn',
};
const PROFILE = { bio: 'profileBio', country: 'profileCountry', timezone: 'profileTimezone', avatarUrl: 'profileAvatarUrl', avatarPublicId: 'profileAvatarPublicId' };
const NOTIFICATIONS = {
  readingReminders: 'notifyReadingReminders',
  sequenceDeadline: 'notifySequenceDeadline',
  productUpdates: 'notifyProductUpdates',
  marketing: 'notifyMarketing',
};
const SETTINGS = { reminderTime: 'reminderTime', language: 'language' };
const LEGAL = { termsVersion: 'legalTermsVersion', privacyVersion: 'legalPrivacyVersion', acceptedAt: 'legalAcceptedAt' };
const NESTED = new Set(['profile', 'settings', 'legal', 'identities']);

/** The same nested user object the services use, as table columns. Only the given fields are included. */
function toColumns(changes) {
  const unknown = Object.keys(changes).filter((k) => !(k in TOP_LEVEL) && !NESTED.has(k));
  if (unknown.length) throw new Error(`Unknown user fields: ${unknown.join(', ')}`);
  return {
    ...pickColumns(changes, TOP_LEVEL),
    // The phone's country always follows the phone, whichever route changes it.
    ...(changes.phone !== undefined ? { phoneCountry: countryOfPhone(changes.phone) } : {}),
    ...pickColumns(changes.profile, PROFILE),
    ...pickColumns(changes.settings?.notifications, NOTIFICATIONS),
    ...pickColumns(changes.settings, SETTINGS),
    ...pickColumns(changes.legal, LEGAL),
  };
}

function toUser(row, identities, { secrets }) {
  if (!row) return null;
  const user = {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    identities: identities.map((i) => ({ provider: i.provider, providerId: i.providerId, email: i.email, linkedAt: i.linkedAt })),
    role: row.role,
    status: row.status,
    emailVerifiedAt: row.emailVerifiedAt,
    cohort: row.cohort,
    readinessTier: row.readinessTier,
    segmentTags: row.segmentTags,
    questionnaireSubmission: row.questionnaireSubmissionId,
    profile: {
      bio: row.profileBio,
      country: row.profileCountry,
      timezone: row.profileTimezone,
      avatarUrl: row.profileAvatarUrl,
      avatarPublicId: row.profileAvatarPublicId,
    },
    settings: {
      notifications: {
        readingReminders: row.notifyReadingReminders,
        sequenceDeadline: row.notifySequenceDeadline,
        productUpdates: row.notifyProductUpdates,
        marketing: row.notifyMarketing,
      },
      reminderTime: row.reminderTime,
      language: row.language,
    },
    legal: { termsVersion: row.legalTermsVersion, privacyVersion: row.legalPrivacyVersion, acceptedAt: row.legalAcceptedAt },
    memberSince: row.memberSince,
    membershipType: row.membershipType ?? null,
    membershipTypeSince: row.membershipTypeSince ?? null,
    walletCents: row.walletCents ?? 0,
    passwordChangedAt: row.passwordChangedAt,
    lastLoginAt: row.lastLoginAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (secrets) {
    user.passwordHash = row.passwordHash;
    user.failedLoginAttempts = row.failedLoginAttempts;
    user.lockUntil = row.lockUntil;
  }
  return user;
}

async function load(where, { secrets = false } = {}) {
  const [row] = await db().select().from(U).where(where).limit(1);
  if (!row) return null;
  const identities = await db().select().from(I).where(eq(I.userId, row.id));
  return toUser(row, identities, { secrets });
}

const taken = async (column, value, exceptId) => {
  const rows = await db()
    .select({ id: U.id })
    .from(U)
    .where(and(eq(column, value), exceptId ? ne(U.id, exceptId) : undefined))
    .limit(1);
  return rows.length > 0;
};

module.exports = {
  findById(id, { secrets = false } = {}) {
    return load(eq(U.id, id), { secrets });
  },

  /** `statuses` limits the match, e.g. ['probation', 'member'] for accounts that may reset a password. */
  findByEmail(email, { secrets = false, statuses } = {}) {
    return load(and(eq(U.email, email), statuses ? inArray(U.status, statuses) : undefined), { secrets });
  },

  async findByIdentity(provider, providerId) {
    const [link] = await db()
      .select({ userId: I.userId })
      .from(I)
      .where(and(eq(I.provider, provider), eq(I.providerId, providerId)))
      .limit(1);
    return link ? load(eq(U.id, link.userId)) : null;
  },

  emailTaken: (email, exceptId) => taken(U.email, email, exceptId),
  phoneTaken: (phone, exceptId) => taken(U.phone, phone, exceptId),

  /** Throws DuplicateError when the email (or phone, or Google account) is already used. */
  async create(fields) {
    const id = await translateDuplicate(() =>
      db().transaction(async (tx) => {
        const [row] = await tx.insert(U).values(toColumns(fields)).returning({ id: U.id });
        if (fields.identities?.length) {
          await tx.insert(I).values(fields.identities.map((i) => ({ ...i, userId: row.id })));
        }
        return row.id;
      }),
    );
    return load(eq(U.id, id), { secrets: true });
  },

  /** Partial update; nested objects (profile, settings, legal) only change the given fields. */
  async update(id, changes) {
    const columns = toColumns(changes);
    if (Object.keys(columns).length) {
      await translateDuplicate(() =>
        db()
          .update(U)
          .set({ ...columns, updatedAt: new Date() })
          .where(eq(U.id, id)),
      );
    }
    return load(eq(U.id, id));
  },

  /** Development only (seed scripts): moves the sign-up date, where the apprenticeship's days count from. */
  async setCreatedAt(id, at) {
    await db().update(U).set({ createdAt: at }).where(eq(U.id, id));
  },

  async addIdentity(id, identity) {
    await translateDuplicate(() => db().insert(I).values({ ...identity, userId: id }));
  },

  async remove(id) {
    await db().delete(U).where(eq(U.id, id));
  },

  /**
   * The community map: per country, how many users are still on probation ("registered") and how many are
   * full members, largest first. A user's country is always their phone number's (never the editable profile
   * country); users without a number have none. Suspended and deleted accounts are left out.
   * Resolves to { registered, members, countries: [{ code, registered, members }] }; the two totals also
   * count users with no known country.
   */
  async countryCounts() {
    const result = await db().execute(sql`
      select phone_country as code,
        count(*) filter (where status = 'probation')::int as registered,
        count(*) filter (where status = 'member')::int as members
      from users
      where status in ('probation', 'member')
      group by 1
      order by count(*) desc, 1`);
    const rows = result.rows ?? result;
    return {
      registered: rows.reduce((sum, r) => sum + r.registered, 0),
      members: rows.reduce((sum, r) => sum + r.members, 0),
      countries: rows.filter((r) => r.code).map((r) => ({ code: r.code, registered: r.registered, members: r.members })),
    };
  },

  /** One-off after adding phone_country: fills it for numbers saved before the column existed. Safe to re-run. */
  async backfillPhoneCountries() {
    const rows = await db()
      .select({ id: U.id, phone: U.phone })
      .from(U)
      .where(sql`${U.phone} is not null and ${U.phoneCountry} is null`);
    let filled = 0;
    for (const row of rows) {
      const phoneCountry = countryOfPhone(row.phone);
      if (!phoneCountry) continue;
      await db().update(U).set({ phoneCountry }).where(eq(U.id, row.id));
      filled += 1;
    }
    return filled;
  },

  /** Probation to member (membership is free). Resolves to true, or false when the user was not on probation. */
  async promoteToMember(id, now = new Date(), membershipType = null) {
    const rows = await db()
      .update(U)
      .set({ status: 'member', memberSince: now, membershipType, membershipTypeSince: now, updatedAt: now })
      .where(and(eq(U.id, id), eq(U.status, 'probation')))
      .returning({ id: U.id });
    return rows.length > 0;
  },

  /** Records the membership a member chose (or changed to); its first two-month period starts now. */
  async setMembershipType(id, membershipType, now = new Date()) {
    await db().update(U).set({ membershipType, membershipTypeSince: now, updatedAt: now }).where(eq(U.id, id));
  },

  /** Adds `cents` to the member's wallet. Resolves to the new balance. */
  async addToWallet(id, cents, now = new Date()) {
    const rows = await db()
      .update(U)
      .set({ walletCents: sql`${U.walletCents} + ${cents}`, updatedAt: now })
      .where(eq(U.id, id))
      .returning({ walletCents: U.walletCents });
    return rows[0]?.walletCents ?? null;
  },
};
