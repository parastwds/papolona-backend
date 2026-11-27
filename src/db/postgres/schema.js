/**
 * PostgreSQL schema (Drizzle).
 * After changing it, run `npm run db:generate` to write a new migration into ./drizzle.
 *
 * Ids are UUIDv7 made by Postgres 18's uuidv7(): time-ordered, so "newest first" can sort by id.
 * Allowed values (status, source...) are CHECK constraints, which are easier to change than enum types.
 */
const { sql } = require('drizzle-orm');
const { pgTable, uuid, text, integer, serial, boolean, timestamp, jsonb, doublePrecision, index, uniqueIndex, check, primaryKey } =
  require('drizzle-orm/pg-core');

const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const at = (name) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => at('created_at').notNull().defaultNow();
const updatedAt = () => at('updated_at').notNull().defaultNow();
const oneOf = (column, values) => sql`${column} in (${sql.join(values.map((v) => sql.raw(`'${v}'`)), sql`, `)})`;

const USER_STATUSES = ['probation', 'member', 'suspended', 'deleted'];
// Chosen at graduation: what the member pays for and the benefits they get (see membership.service).
const MEMBERSHIP_TYPES = ['explorer', 'creator', 'collector'];
const REVOKE_REASONS = ['logout', 'logout_all', 'password_changed', 'password_reset', 'token_reuse', 'account_deleted'];

const questionnaires = pgTable('questionnaires', {
  id: id(),
  version: integer('version').notNull().unique(),
  isActive: boolean('is_active').notNull().default(false),
  // showCohortToUser, cohorts, tieBreakQuestions, tieBreak, readinessTiers, questions: always read as one document.
  definition: jsonb('definition').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

const users = pgTable(
  'users',
  {
    id: id(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    phone: text('phone').unique(), // E.164; NULLs do not clash
    // ISO 3166-1 alpha-2 country of `phone`, derived on every write (db/postgres/users.js). Feeds the community map.
    phoneCountry: text('phone_country'),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('user'),
    status: text('status').notNull().default('probation'),
    emailVerifiedAt: at('email_verified_at'),
    cohort: text('cohort'),
    readinessTier: text('readiness_tier'),
    segmentTags: text('segment_tags').array().notNull().default(sql`'{}'::text[]`),
    // No foreign key: submissions point back at users, and the link is checked in code.
    questionnaireSubmissionId: uuid('questionnaire_submission_id'),

    profileBio: text('profile_bio').notNull().default(''),
    profileCountry: text('profile_country'),
    profileTimezone: text('profile_timezone'),
    profileAvatarUrl: text('profile_avatar_url'),
    profileAvatarPublicId: text('profile_avatar_public_id'),

    notifyReadingReminders: boolean('notify_reading_reminders').notNull().default(true),
    notifySequenceDeadline: boolean('notify_sequence_deadline').notNull().default(true),
    notifyProductUpdates: boolean('notify_product_updates').notNull().default(true),
    notifyMarketing: boolean('notify_marketing').notNull().default(false),
    reminderTime: text('reminder_time').notNull().default('09:00'),
    // The user's local date (YYYY-MM-DD) the daily reading reminder was last emailed: at most one a day.
    readingReminderSentOn: text('reading_reminder_sent_on'),
    language: text('language').notNull().default('en'),

    legalTermsVersion: text('legal_terms_version'),
    legalPrivacyVersion: text('legal_privacy_version'),
    legalAcceptedAt: at('legal_accepted_at'),

    // No longer used: the timer of the retired clue cooldown, kept so old rows stay readable.
    nextClueAt: at('next_clue_at'),
    // When the user paid for membership and their status became 'member'; null before that.
    memberSince: at('member_since'),
    // The membership the member chose at graduation (MEMBERSHIP_TYPES); null for members from before the
    // choice existed, and for apprentices.
    membershipType: text('membership_type'),
    // When the current membership type was chosen: its first two-month period starts here.
    membershipTypeSince: at('membership_type_since'),
    // The member's wallet balance (demo payments only for now), in MEMBERSHIP_CURRENCY cents.
    walletCents: integer('wallet_cents').notNull().default(0),
    // The end of the active window the user was last emailed a "convert an NFT to stay active" nudge for.
    activeReminderFor: at('active_reminder_for'),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockUntil: at('lock_until'),
    passwordChangedAt: at('password_changed_at'),
    lastLoginAt: at('last_login_at'),
    deletedAt: at('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('users_role_check', oneOf(t.role, ['user', 'admin'])),
    check('users_status_check', oneOf(t.status, USER_STATUSES)),
    check('users_membership_type_check', sql`${t.membershipType} is null or ${oneOf(t.membershipType, MEMBERSHIP_TYPES)}`),
    check('users_name_length', sql`char_length(${t.name}) <= 80`),
    check('users_bio_length', sql`char_length(${t.profileBio}) <= 500`),
    index('users_status_idx').on(t.status),
    index('users_cohort_idx').on(t.cohort),
  ],
);

const userIdentities = pgTable(
  'user_identities',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerId: text('provider_id').notNull(),
    email: text('email'),
    linkedAt: at('linked_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'user_identities_pkey', columns: [t.provider, t.providerId] }),
    check('user_identities_provider_check', oneOf(t.provider, ['google'])),
    index('user_identities_user_idx').on(t.userId),
  ],
);

const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    family: text('family').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    previousTokenHashes: text('previous_token_hashes').array().notNull().default(sql`'{}'::text[]`), // never sent to clients
    expiresAt: at('expires_at').notNull(),
    lastUsedAt: at('last_used_at').notNull().defaultNow(),
    revokedAt: at('revoked_at'),
    revokedReason: text('revoked_reason'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    platform: text('platform'),
    appVersion: text('app_version'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('sessions_revoked_reason_check', sql`${t.revokedReason} is null or ${oneOf(t.revokedReason, REVOKE_REASONS)}`),
    index('sessions_user_idx').on(t.userId),
    index('sessions_family_idx').on(t.family),
    index('sessions_previous_token_hashes_idx').using('gin', t.previousTokenHashes),
  ],
);

// Emailed 6-digit codes: only the HMAC of the code is stored.
const codeColumns = () => ({
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  expiresAt: at('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  usedAt: at('used_at'),
  invalidatedAt: at('invalidated_at'),
  ip: text('ip'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

const passwordResets = pgTable('password_resets', codeColumns(), (t) => [index('password_resets_user_idx').on(t.userId, t.createdAt)]);

const pendingChanges = pgTable(
  'pending_changes',
  {
    ...codeColumns(),
    type: text('type').notNull(),
    value: text('value'), // new email, new phone (null = remove), or new password hash
    sentTo: text('sent_to').notNull(),
  },
  (t) => [
    check('pending_changes_type_check', oneOf(t.type, ['password', 'email', 'phone'])),
    index('pending_changes_user_type_idx').on(t.userId, t.type, t.createdAt),
  ],
);

const questionnaireSubmissions = pgTable(
  'questionnaire_submissions',
  {
    id: id(),
    questionnaireId: uuid('questionnaire_id').notNull().references(() => questionnaires.id),
    questionnaireVersion: integer('questionnaire_version').notNull(),
    answers: jsonb('answers').notNull(), // [{ questionKey, optionKeys }]
    scores: jsonb('scores').notNull(), // [{ cohort, score }]
    cohort: text('cohort').notNull(),
    readinessScore: doublePrecision('readiness_score'),
    readinessTier: text('readiness_tier'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    linkedUserId: uuid('linked_user_id').references(() => users.id, { onDelete: 'set null' }),
    linkedAt: at('linked_at'),
    deviceId: text('device_id'),
    ip: text('ip'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('questionnaire_submissions_cohort_idx').on(t.cohort),
    index('questionnaire_submissions_readiness_tier_idx').on(t.readinessTier),
    index('questionnaire_submissions_linked_user_idx').on(t.linkedUserId),
  ],
);

const legalAcceptances = pgTable(
  'legal_acceptances',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    document: text('document').notNull(),
    version: text('version').notNull(),
    context: text('context').notNull(),
    acceptedAt: at('accepted_at').notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    check('legal_acceptances_document_check', oneOf(t.document, ['terms', 'privacy'])),
    check('legal_acceptances_context_check', oneOf(t.context, ['register', 'reaccept'])),
    index('legal_acceptances_user_idx').on(t.userId),
  ],
);

/**
 * Single row (key = 'app') read by the Splash screen: force-update, maintenance mode, and the current
 * Terms / Privacy versions (the text is in the app). Defaults are in src/db/appConfig.js.
 */
const appConfig = pgTable('app_config', {
  key: text('key').primaryKey().default('app'),
  config: jsonb('config').notNull(), // minSupportedVersion, latestVersion, storeUrls, maintenance, supportEmail, legal
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

const SERIES_STATUSES = ['active', 'completed', 'abandoned', 'failed'];
const SERIES_RARITIES = ['common', 'epic', 'mythic', 'legendary'];
const MINT_CHOICES = ['keep', 'mint', 'mint_poc'];
const BADGES = ['intuitive_insight', 'curated_collection', 'archive_edition', 'master_collection', 'founder'];

// A member's series: a run of 1, 2, 3, 6, 12 or 24 readings. Each reading the judge passes reveals one
// tile of the artwork's grid (rows x cols = length); the longer the series, the rarer it is. Completing
// a 3+ series earns a badge; 12 and 24 also unlock mint rights. A series has failed, and is lost, when a
// reading in it fails all its attempts or is not completed in time ('abandoned': the older deadline rule).
const nftSeries = pgTable(
  'nft_series',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    length: integer('length').notNull(),
    rows: integer('rows').notNull(),
    cols: integer('cols').notNull(),
    rarity: text('rarity').notNull(),
    status: text('status').notNull().default('active'),
    // The placeholder artwork the NFT will show, until generated artwork exists (a key the app maps to an image).
    artworkKey: text('artwork_key').notNull(),
    // Every tile index (0 .. length-1) in the random order they are revealed; kept from the app.
    revealOrder: integer('reveal_order').array().notNull(),
    // The tiles revealed so far, in the order they were revealed.
    revealedTiles: integer('revealed_tiles').array().notNull().default(sql`'{}'::integer[]`),
    startedAt: at('started_at').notNull(),
    lastReadingAt: at('last_reading_at'),
    // The next reading must be drawn by then, or the series is abandoned.
    deadlineAt: at('deadline_at').notNull(),
    completedAt: at('completed_at'),
    abandonedAt: at('abandoned_at'),
    failedAt: at('failed_at'),
    // Added to the public collective artwork (a paid publish), or null.
    publishedAt: at('published_at'),
    publishPaymentId: uuid('publish_payment_id').references(() => payments.id, { onDelete: 'set null' }),
    // What the member chose for a mint-eligible (12/24) series: keep in the gallery, mint, or mint + POC.
    // Recorded only; there is no on-chain minting yet.
    mintChoice: text('mint_choice'),
    mintChoiceAt: at('mint_choice_at'),
    // The member who made it. user_id is who owns it now: an NFT bought on the marketplace changes hands.
    creatorId: uuid('creator_id').references(() => users.id, { onDelete: 'set null' }),
    // Converted into an NFT (a paid conversion, demo payments for now), or null.
    convertedAt: at('converted_at'),
    conversionPaymentId: uuid('conversion_payment_id').references(() => payments.id, { onDelete: 'set null' }),
    // Its reference number: a running number across Papolona, and the membership it was made under
    // (EX Explorer, CR Creator, CO Collector, UN Universal, ME a member from before memberships existed).
    // Shown as e.g. CR3-00042 (membership, level, number).
    refSeq: serial('ref_seq'),
    refCode: text('ref_code').notNull().default('ME'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('nft_series_length_check', sql`${t.length} in (1, 2, 3, 6, 12, 24)`),
    check('nft_series_mint_choice_check', sql`${t.mintChoice} is null or ${oneOf(t.mintChoice, MINT_CHOICES)}`),
    index('nft_series_published_idx').on(t.publishedAt.desc()).where(sql`${t.publishedAt} is not null`),
    check('nft_series_grid_check', sql`${t.rows} * ${t.cols} = ${t.length}`),
    check('nft_series_rarity_check', oneOf(t.rarity, SERIES_RARITIES)),
    check('nft_series_status_check', oneOf(t.status, SERIES_STATUSES)),
    // One series at a time.
    uniqueIndex('nft_series_one_active_idx').on(t.userId).where(sql`${t.status} = 'active'`),
    index('nft_series_user_idx').on(t.userId, t.startedAt),
  ],
);

const clueDraws = pgTable(
  'clue_draws',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clue: text('clue').notNull(),
    // What the user asked before drawing; '' for draws made before questions existed.
    question: text('question').notNull().default(''),
    generatedAt: at('generated_at').notNull(),
    nextAvailableAt: at('next_available_at').notNull(),
    // The user's interpretation of the clue and the AI judge's verdict on it (the latest attempt), all null
    // until it is judged. A fail may be resubmitted until `attempts` reaches three. A pass is one day of probation.
    interpretation: text('interpretation'),
    interpretationSource: text('interpretation_source'),
    verdict: text('verdict'),
    // { parts: [{ part, meaning }], feedback, model } from the judge.
    judgement: jsonb('judgement'),
    judgedAt: at('judged_at'),
    // How many times the interpretation has been judged.
    attempts: integer('attempts').notNull().default(0),
    // When the "last hour to complete it" warning was emailed (null until then).
    deadlineWarnedAt: at('deadline_warned_at'),
    // How eerie (uncanny, synchronous) and how satisfying the reading felt, 1–10: rated by the user after
    // the reading, and by the AI judge from the interpretation. Null until rated.
    userEeriness: integer('user_eeriness'),
    userSatisfaction: integer('user_satisfaction'),
    ratedAt: at('rated_at'),
    aiEeriness: integer('ai_eeriness'),
    aiSatisfaction: integer('ai_satisfaction'),
    // The NFT series this reading was drawn in, if any, and the tile its pass revealed (null until then).
    seriesId: uuid('series_id').references(() => nftSeries.id, { onDelete: 'set null' }),
    tileIndex: integer('tile_index'),
    // The AI prompt the user asked for by tapping the clue: { options: [{ parts: [{ part, meaning }] }], model }.
    // One per clue (tapping again shows the same choices); each counts against the monthly allowance.
    prompt: jsonb('prompt'),
    promptedAt: at('prompted_at'),
    // The user's contest of the judgement on a reading that failed all its attempts: why they think it is
    // coherent, emailed to Papolona. One per reading.
    contestText: text('contest_text'),
    contestedAt: at('contested_at'),
  },
  (t) => [
    index('clue_draws_user_generated_idx').on(t.userId, t.generatedAt.desc()),
    index('clue_draws_user_prompted_idx').on(t.userId, t.promptedAt).where(sql`${t.promptedAt} is not null`),
    check('clue_draws_verdict_check', sql`${t.verdict} is null or ${t.verdict} in ('pass', 'fail')`),
    check(
      'clue_draws_source_check',
      sql`${t.interpretationSource} is null or ${t.interpretationSource} in ('text', 'voice')`,
    ),
    check(
      'clue_draws_ratings_check',
      sql`coalesce(${t.userEeriness}, 1) between 1 and 10 and coalesce(${t.userSatisfaction}, 1) between 1 and 10 and coalesce(${t.aiEeriness}, 1) between 1 and 10 and coalesce(${t.aiSatisfaction}, 1) between 1 and 10`,
    ),
  ],
);

// Achievement badges: one per completed 3+ series (series_id set), and the founder badge for the first
// mint-eligible completions (at most one per user).
const userBadges = pgTable(
  'user_badges',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    seriesId: uuid('series_id').references(() => nftSeries.id, { onDelete: 'cascade' }),
    badge: text('badge').notNull(),
    awardedAt: at('awarded_at').notNull().defaultNow(),
  },
  (t) => [
    check('user_badges_badge_check', oneOf(t.badge, BADGES)),
    uniqueIndex('user_badges_series_badge_idx').on(t.seriesId, t.badge),
    uniqueIndex('user_badges_one_founder_idx').on(t.userId).where(sql`${t.badge} = 'founder'`),
    index('user_badges_user_idx').on(t.userId, t.awardedAt),
  ],
);

// membership: the old one-time fee (membership is free now); publish: adding a series to the collective artwork.
// wallet_deposit: money put into the member's (demo) wallet; collector_fee: the Collector's two-monthly fee;
// donation: a gift to Papolona from any user.
const PAYMENT_PURPOSES = ['membership', 'publish', 'conversion', 'nft_purchase', 'stone', 'wallet_deposit', 'collector_fee', 'donation'];
const PAYMENT_PROVIDERS = ['demo'];
const PAYMENT_STATUSES = ['succeeded', 'failed', 'refunded'];

// Money the user paid. Only the demo provider exists
// for now; a real one (Stripe, Razorpay…) adds its name and fills providerRef with its payment id.
const payments = pgTable(
  'payments',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),
    provider: text('provider').notNull(),
    providerRef: text('provider_ref'),
    status: text('status').notNull(),
    // The payer's billing info when they paid (see billingProfiles), for receipts; null if none was saved.
    billing: jsonb('billing'),
    createdAt: createdAt(),
  },
  (t) => [
    check('payments_purpose_check', oneOf(t.purpose, PAYMENT_PURPOSES)),
    check('payments_provider_check', oneOf(t.provider, PAYMENT_PROVIDERS)),
    check('payments_status_check', oneOf(t.status, PAYMENT_STATUSES)),
    check('payments_amount_check', sql`${t.amountCents} > 0`),
    index('payments_user_idx').on(t.userId, t.createdAt),
  ],
);

// Applications for the Château de Puycharnaud retreat: one per user, reviewed by the team.
const RETREAT_STATUSES = ['pending', 'accepted', 'declined'];
const retreatApplications = pgTable(
  'retreat_applications',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    motivation: text('motivation').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('retreat_applications_user_idx').on(t.userId),
    check('retreat_applications_status_check', oneOf(t.status, RETREAT_STATUSES)),
  ],
);

// Who pays: one billing profile per user, set in Settings and used for every payment (and to fill the
// package's postal address).
const billingProfiles = pgTable('billing_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  fullName: text('full_name').notNull(),
  email: text('email').notNull(),
  phone: text('phone').notNull().default(''),
  addressLine1: text('address_line1').notNull(),
  addressLine2: text('address_line2').notNull().default(''),
  city: text('city').notNull(),
  postcode: text('postcode').notNull(),
  country: text('country').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// The package active membership asks for: one order per user, shipped to this address. stone_triptych is
// the meditation stone and the giclée triptych; retreat adds a meditative stay at Château de Puycharnaud.
const ORDER_PACKAGES = ['stone_triptych', 'retreat'];
const stoneOrders = pgTable(
  'stone_orders',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    package: text('package').notNull().default('stone_triptych'),
    recipientName: text('recipient_name').notNull(),
    addressLine1: text('address_line1').notNull(),
    addressLine2: text('address_line2').notNull().default(''),
    city: text('city').notNull(),
    postcode: text('postcode').notNull(),
    country: text('country').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('stone_orders_user_idx').on(t.userId),
    check('stone_orders_package_check', oneOf(t.package, ORDER_PACKAGES)),
  ],
);

const LISTING_STATUSES = ['active', 'sold', 'cancelled'];

// The marketplace: an active member offers one of their NFTs at a price. A sale moves the NFT to the
// buyer; the seller gets their share and Papolona keeps fee_cents. A listing opens as an auction for
// Collectors until collectors_until (bids in nft_bids, the highest wins); with no bids by then it is open
// to everyone at price_cents. Listings from before auctions have no collectors_until: open to everyone.
const nftListings = pgTable(
  'nft_listings',
  {
    id: id(),
    seriesId: uuid('series_id').notNull().references(() => nftSeries.id, { onDelete: 'cascade' }),
    sellerId: uuid('seller_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    // The starting price; once sold, what the buyer paid (the winning bid, after an auction).
    priceCents: integer('price_cents').notNull(),
    collectorsUntil: at('collectors_until'),
    currency: text('currency').notNull(),
    status: text('status').notNull().default('active'),
    buyerId: uuid('buyer_id').references(() => users.id, { onDelete: 'set null' }),
    salePaymentId: uuid('sale_payment_id').references(() => payments.id, { onDelete: 'set null' }),
    feeCents: integer('fee_cents'),
    sellerProceedsCents: integer('seller_proceeds_cents'),
    soldAt: at('sold_at'),
    cancelledAt: at('cancelled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('nft_listings_status_check', oneOf(t.status, LISTING_STATUSES)),
    check('nft_listings_price_check', sql`${t.priceCents} > 0`),
    // One open listing per NFT.
    uniqueIndex('nft_listings_one_active_idx').on(t.seriesId).where(sql`${t.status} = 'active'`),
    index('nft_listings_active_idx').on(t.status, t.createdAt),
    index('nft_listings_seller_idx').on(t.sellerId, t.createdAt),
  ],
);

// Collectors' bids on a listing during its auction. Each must beat the highest so far.
const nftBids = pgTable(
  'nft_bids',
  {
    id: id(),
    listingId: uuid('listing_id').notNull().references(() => nftListings.id, { onDelete: 'cascade' }),
    bidderId: uuid('bidder_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    amountCents: integer('amount_cents').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('nft_bids_amount_check', sql`${t.amountCents} > 0`),
    index('nft_bids_listing_idx').on(t.listingId, t.amountCents),
  ],
);

const REMINDER_REPEATS = ['none', 'daily', 'weekly', 'monthly'];

// The user's own reminders from the Journal, emailed when due.
const reminders = pgTable(
  'reminders',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    note: text('note').notNull().default(''),
    // The first time it was set for; repeats keep this local time of day in `timeZone`.
    startsAt: at('starts_at').notNull(),
    // When it is next due (the dispatcher moves this on after each repeat).
    remindAt: at('remind_at').notNull(),
    repeat: text('repeat').notNull().default('none'),
    timeZone: text('time_zone').notNull(),
    // False once a one-off reminder has been sent, or when the user pauses it.
    active: boolean('active').notNull().default(true),
    lastSentAt: at('last_sent_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('reminders_repeat_check', oneOf(t.repeat, REMINDER_REPEATS)),
    check('reminders_title_length', sql`char_length(${t.title}) between 1 and 120`),
    check('reminders_note_length', sql`char_length(${t.note}) <= 1000`),
    index('reminders_due_idx').on(t.active, t.remindAt),
    index('reminders_user_idx').on(t.userId, t.remindAt),
  ],
);

const journalEntries = pgTable(
  'journal_entries',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    source: text('source').notNull(),
    // Made by the app, so a retried create returns the same entry instead of a duplicate.
    clientId: text('client_id').notNull(),
    // The clue this entry was sealed with; null while the entry is still open.
    clueDrawId: uuid('clue_draw_id').references(() => clueDraws.id, { onDelete: 'set null' }),
    // [{ publicId, url, width, height }]: Cloudinary photos, the url built by the server from the publicId.
    photos: jsonb('photos').notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    check('journal_entries_source_check', oneOf(t.source, ['text', 'voice'])),
    uniqueIndex('journal_entries_user_client_idx').on(t.userId, t.clientId),
    index('journal_entries_user_id_idx').on(t.userId, t.id.desc()),
    index('journal_entries_user_clue_idx').on(t.userId, t.clueDrawId),
  ],
);

/**
 * The AI reading of one day of a user's journal: the entries refined into one reflection, and reflective questions.
 * `entriesHash` records which entries it was made from, so it is regenerated only when they change.
 */
const journalInsights = pgTable(
  'journal_insights',
  {
    id: id(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    day: text('day').notNull(), // YYYY-MM-DD in the user's time zone
    entriesHash: text('entries_hash').notNull(),
    refined: text('refined').notNull(),
    // Reflective questions about the day. The column keeps its first name (key_points), from
    // before the AI asked questions, so no migration was needed.
    questions: text('key_points').array().notNull().default(sql`'{}'::text[]`),
    model: text('model').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('journal_insights_user_day_idx').on(t.userId, t.day),
    check('journal_insights_day_format', sql`${t.day} ~ '^\\d{4}-\\d{2}-\\d{2}$'`),
  ],
);

const DM_STATUSES = ['pending', 'accepted', 'declined'];

// Direct messages: one thread per pair of users (user_a is the smaller id, user_b the larger). It opens as
// a message request from requested_by; once the other accepts, both can write. Each side's read_at marks
// what they have seen.
const dmThreads = pgTable(
  'dm_threads',
  {
    id: id(),
    userA: uuid('user_a').notNull().references(() => users.id, { onDelete: 'cascade' }),
    userB: uuid('user_b').notNull().references(() => users.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    acceptedAt: at('accepted_at'),
    lastMessageAt: at('last_message_at'),
    userAReadAt: at('user_a_read_at'),
    userBReadAt: at('user_b_read_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('dm_threads_pair_idx').on(t.userA, t.userB),
    index('dm_threads_user_b_idx').on(t.userB),
    check('dm_threads_status_check', oneOf(t.status, DM_STATUSES)),
    check('dm_threads_order_check', sql`${t.userA} < ${t.userB}`),
  ],
);

const dmMessages = pgTable(
  'dm_messages',
  {
    id: id(),
    threadId: uuid('thread_id').notNull().references(() => dmThreads.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('dm_messages_thread_idx').on(t.threadId, t.createdAt)],
);

// A user blocking another: neither can message the other, and they stop appearing to each other in search.
const userBlocks = pgTable(
  'user_blocks',
  {
    blockerId: uuid('blocker_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), index('user_blocks_blocked_idx').on(t.blockedId)],
);

const ACCESS_STATUSES = ['pending', 'approved', 'denied'];

// A member asking to see another member's readings and NFTs on their profile. The owner approves or denies.
const profileAccess = pgTable(
  'profile_access',
  {
    id: id(),
    ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    viewerId: uuid('viewer_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    answeredAt: at('answered_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('profile_access_pair_idx').on(t.ownerId, t.viewerId),
    index('profile_access_owner_status_idx').on(t.ownerId, t.status),
    check('profile_access_status_check', oneOf(t.status, ACCESS_STATUSES)),
  ],
);

module.exports = {
  questionnaires,
  users,
  userIdentities,
  sessions,
  passwordResets,
  pendingChanges,
  questionnaireSubmissions,
  legalAcceptances,
  appConfig,
  clueDraws,
  journalEntries,
  journalInsights,
  reminders,
  REMINDER_REPEATS,
  payments,
  nftSeries,
  userBadges,
  stoneOrders,
  billingProfiles,
  retreatApplications,
  nftListings,
  nftBids,
  dmThreads,
  dmMessages,
  userBlocks,
  profileAccess,
  MINT_CHOICES,
  BADGES,
};
