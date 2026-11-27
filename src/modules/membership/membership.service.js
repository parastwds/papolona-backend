const env = require('../../config/env');
const db = require('../../db');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { sendMail } = require('../../utils/mailer');
const users = require('../users/users.service');
const series = require('../series/series.service');
const standing = require('./standing');

/**
 * Membership, in three steps:
 * - Apprentice ('probation'): at least PROBATION_DAYS from sign-up, and at least PROBATION_READINGS passed
 *   readings in a multiple of PROBATION_STEP (see users.getProbation).
 * - Member: once the apprenticeship is complete the user joins the collective and chooses a membership
 *   (MEMBERSHIP_TYPES: Explorer, Creator or Collector), which unlocks series. Explorer and Collector start
 *   at once. Creator starts provisional: they read like an Explorer until their first Level 1 conversion
 *   makes them a full Creator (and starts their monthly fee); a member who was a full Creator before is
 *   full again at once. Members keep their emblems in their gallery and can buy on the marketplace. The
 *   membership is separate from the questionnaire's cohort, which only suggests one.
 * - Active member: a member who has bought the Sensitisation Package and paid to convert an emblem into an
 *   NFT within the last ACTIVE_WINDOW_DAYS. Each conversion opens a new window; there is no upper limit.
 *   Only active members can sell their NFTs on the marketplace. A member whose window closes is no longer
 *   active until they convert again; they keep everything else.
 * Everything is paid in Papolona pennies (see pennies.service).
 */

const DAY = 24 * 60 * 60 * 1000;
// Prices are in Papolona pennies; the *_CENTS settings are pennies (1 penny = 1 cent).
const PENNIES = 'PNY';
const windowMs = () => env.ACTIVE_WINDOW_DAYS * DAY;

/**
 * The package active membership asks for, bought once: the Sensitisation Package, "Initiation into the
 * Papolona Method". Its id stays 'stone_triptych' for orders placed before it was renamed. Orders of the
 * old 'retreat' package (stone, triptych and a stay) still count; it is no longer sold, as the retreat is
 * now by application (see retreatStatus).
 */
const PACKAGES = [
  {
    id: 'stone_triptych',
    title: 'Sensitisation Package',
    subtitle: 'Initiation into the Papolona Method',
    includes: [
      'The meditation stone',
      'Enigma Prism Triptych (giclée print)',
      'Initiation materials',
      'A retreat stay at Château de Puycharnaud',
    ],
    priceCents: () => env.PACKAGE_STONE_TRIPTYCH_CENTS,
  },
];
const PACKAGE_IDS = PACKAGES.map((p) => p.id);

const packagePrice = (pkg) => {
  const priceCents = pkg.priceCents();
  return {
    priceCents,
    postageCents: env.STONE_POSTAGE_CENTS,
    totalCents: priceCents + env.STONE_POSTAGE_CENTS,
    currency: PENNIES,
  };
};
const findPackage = (id) => PACKAGES.find((p) => p.id === id);
const listPackages = () =>
  PACKAGES.map((p) => ({ id: p.id, title: p.title, subtitle: p.subtitle, includes: p.includes, ...packagePrice(p) }));

/**
 * The Château de Puycharnaud retreat: a few days, a few places a year, by application. Its price range is
 * shown; nothing is charged when applying. { days, priceFromCents, priceToCents, currency, application }.
 */
async function retreatStatus(user) {
  return {
    days: env.RETREAT_DAYS,
    priceFromCents: env.RETREAT_PRICE_FROM_CENTS,
    priceToCents: env.RETREAT_PRICE_TO_CENTS,
    currency: env.PACKAGE_CURRENCY,
    application: await db.retreat.findApplication(user.id),
  };
}
// The first package, which app builds from before packages show as "the stone".
const stonePrice = () => packagePrice(PACKAGES[0]);

/**
 * The memberships a member chooses from at graduation, and can change later (prices are provisional;
 * demo payments charge the first month of a paid one):
 * - Explorer: free; singles, twins and Level 1 series only; cannot convert or sell (no profit).
 * - Creator: every level; converts and sells NFTs; must convert at least once every two months.
 * - Collector: free to join; readings optional (any level); supports the ecosystem every two months.
 */
const MEMBERSHIP_TYPES = [
  {
    id: 'explorer',
    title: 'Explorer',
    tagline: 'For personal growth',
    benefits: [
      'Free after graduation',
      'Unlimited Single, Twin and Level 1 readings',
      'Community participation',
      'Upgrade to Creator or Collector to convert and sell NFTs',
    ],
    priceCents: () => env.MEMBERSHIP_EXPLORER_CENTS,
  },
  {
    id: 'creator',
    title: 'Creator',
    tagline: 'For artists, writers and entrepreneurs',
    benefits: [
      'Start as a provisional Creator: Single, Twin and Level 1 readings',
      'Convert your first Level 1 series into an NFT to become a full Creator',
      'Then every level, 1 to 4, and sell your NFTs',
      'Convert at least one series every two months',
      'Papolona acts as your agent: sales revenue shared 50/50',
    ],
    priceCents: () => env.MEMBERSHIP_CREATOR_CENTS,
  },
  {
    id: 'collector',
    title: 'Collector',
    tagline: 'For collecting and provenance',
    benefits: [
      "Buy members' NFTs on the marketplace",
      'Readings optional, at any level',
      'Every two months: buy a member NFT and keep a minimum wallet balance, or pay the Collector fee',
      // The yearly alternative (see standing.js): enough art in 12 months covers those 12 months.
      `Or buy art worth €${(env.COLLECTOR_ART_YEAR_CENTS / 100).toLocaleString('en-US')} or more within 12 months, which covers those 12 months`,
      'Collection management and rarity rankings',
    ],
    priceCents: () => env.MEMBERSHIP_COLLECTOR_CENTS,
  },
];
const MEMBERSHIP_TYPE_IDS = MEMBERSHIP_TYPES.map((t) => t.id);
const findType = (id) => MEMBERSHIP_TYPES.find((t) => t.id === id);
const listTypes = () =>
  MEMBERSHIP_TYPES.map(({ priceCents, ...t }) => ({ ...t, priceCents: priceCents(), currency: PENNIES }));

// The membership the questionnaire's cohort suggests; patrons commission and buy work, like collectors.
const SUGGESTED_BY_COHORT = { creator: 'creator', collector: 'collector', patron: 'collector', explorer: 'explorer' };
const suggestedType = (user) => SUGGESTED_BY_COHORT[user.cohort] ?? 'explorer';

/**
 * Charges the first month of a paid membership in pennies (402 NOT_ENOUGH_PENNIES when short). Free ones,
 * and a provisional Creator (who pays with their first conversion), charge nothing.
 */
async function chargeMembership(user, type) {
  const amount = type.priceCents();
  if (amount === 0) return null;
  if (type.id === 'creator' && !user.creatorConfirmedAt) return null;
  return (await db.pennies.pay(user.id, 'membership', amount, 'membership')).payment;
}

/** Where a Creator stands: 'provisional' until their first Level 1 conversion, then 'full'; null otherwise. */
const creatorStage = (user) =>
  user.status === 'member' && user.membershipType === 'creator' ? (user.creatorConfirmedAt ? 'full' : 'provisional') : null;

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
 * Where the user stands on active membership: { isActive, stoneOrdered, lastConversionAt, activeUntil,
 * windowDays }. activeUntil is when the current window closes (null before the first conversion).
 */
async function activeStatus(user, now = new Date()) {
  const [lastConversionAt, stone] = await Promise.all([
    db.market.lastConversionAt(user.id),
    db.market.findStoneOrder(user.id),
  ]);
  const activeUntil = lastConversionAt ? new Date(lastConversionAt.getTime() + windowMs()) : null;
  return {
    isActive: user.status === 'member' && Boolean(stone) && Boolean(activeUntil && activeUntil > now),
    stoneOrdered: Boolean(stone),
    lastConversionAt,
    activeUntil,
    windowDays: env.ACTIVE_WINDOW_DAYS,
  };
}

/**
 * Membership screen: where the user stands, whether they can join now, active membership, and the terms
 * their membership asks of them (a Creator or Collector who missed them returns to Explorer here).
 */
async function getStatus(signedIn, now = new Date()) {
  const { user, demotedFrom } = await standing.enforce(signedIn, now);
  const [probation, active, stoneOrder, retreat, terms] = await Promise.all([
    users.getProbation(user),
    activeStatus(user, now),
    db.market.findStoneOrder(user.id),
    retreatStatus(user),
    standing.standing(user, now),
  ]);
  const isMember = user.status === 'member';
  const canJoin = !isMember && probation.complete;
  return {
    status: user.status,
    isMember,
    memberSince: user.memberSince ?? null,
    // null for members from before the choice existed: the app asks them to choose.
    membershipType: user.membershipType ?? null,
    membershipTypes: listTypes(),
    // The series lengths this member may start (Explorers: 1, 2 and 6); none before membership.
    allowedSeriesLengths: isMember ? series.allowedLengths(user) : [],
    // Explorers cannot convert or sell.
    canProfit: isMember && !series.isExplorer(user),
    // 'provisional' until a Creator's first Level 1 conversion, then 'full'; null for other memberships.
    creatorStage: creatorStage(user),
    // Collectors are reminded now and then that they can start creating too (Home shows a card).
    creatorInvite: isMember && user.membershipType === 'collector',
    // What a Creator or Collector must do each period to keep their membership, and by when.
    standing: terms,
    // Set once, when this call moved the member back to Explorer: the membership they lost.
    demotedFrom,
    wallet: { balanceCents: user.walletCents ?? 0, currency: PENNIES },
    suggestedType: suggestedType(user),
    probation,
    free: true,
    price: null,
    canJoin,
    // Kept for app builds from before membership was free: they show their pay button when this is true.
    canPay: canJoin,
    demoPayments: env.DEMO_PAYMENTS,
    active,
    stone: { ...stonePrice(), order: stoneOrder },
    packages: listPackages(),
    retreat,
  };
}

/**
 * Makes a user who has finished probation a member with the membership they chose, which every new member
 * must choose, charging the first month of a paid one. Resolves to { membership, payment }.
 * (Members who joined before the choice existed may have none; they can choose with chooseType.)
 */
async function join(user, typeId) {
  const type = findType(typeId);
  if (!type) throw ApiError.badRequest('MEMBERSHIP_TYPE_REQUIRED', 'Choose Explorer, Creator or Collector.');
  if (user.status === 'member') throw ApiError.conflict('ALREADY_MEMBER', 'You are already a member.');
  const probation = await users.getProbation(user);
  if (!probation.complete) {
    throw ApiError.forbidden(
      'PROBATION_INCOMPLETE',
      `Membership opens after the apprenticeship: ${probation.daysRequired} days and ${probation.readingsRequired} or more passed readings in a multiple of ${probation.readingsStep}. So far: day ${probation.daysDone}, ${probation.readingsDone} readings passed.`,
    );
  }
  // Short of pennies for a paid membership: refused before anything changes.
  const fee = type.id === 'creator' && !user.creatorConfirmedAt ? 0 : type.priceCents();
  if (fee > (user.walletCents ?? 0)) {
    throw new ApiError(402, 'NOT_ENOUGH_PENNIES', `This membership needs ${fee.toLocaleString('en-US')} pennies.`, {
      needed: fee,
      balance: user.walletCents ?? 0,
    });
  }
  // False when another request promoted the user first (a double tap): nothing is charged.
  if (!(await db.users.promoteToMember(user.id, new Date(), type.id))) {
    throw ApiError.conflict('ALREADY_MEMBER', 'You are already a member.');
  }
  const payment = await chargeMembership(user, type);
  const updated = await db.users.findById(user.id);
  return { membership: await getStatus(updated), payment: payment && toPayment(payment) };
}

/**
 * Switches a member's membership, at any time. Each switch to a paid membership charges its first month
 * again in pennies, even if the member had it before; Collector is free. Switching to Creator starts
 * provisional (free until the first Level 1 conversion) unless the member was a full Creator before.
 * Members only. Resolves to { membership, payment }.
 */
async function chooseType(user, typeId) {
  const type = findType(typeId);
  if (!type) throw ApiError.badRequest('UNKNOWN_MEMBERSHIP', 'Choose Explorer, Creator or Collector.');
  if (user.status !== 'member') {
    throw ApiError.forbidden('MEMBERSHIP_REQUIRED', 'Join the collective before choosing a membership.');
  }
  if (user.membershipType === type.id) {
    throw ApiError.conflict('SAME_MEMBERSHIP', `This is already your membership.`);
  }
  const payment = await chargeMembership(user, type);
  await db.users.setMembershipType(user.id, type.id);
  const updated = await db.users.findById(user.id);
  return { membership: await getStatus(updated), payment: payment && toPayment(payment) };
}

/**
 * Orders a package (PACKAGES), shipped to `address`, for its price plus postage, in pennies (402
 * NOT_ENOUGH_PENNIES when short). Members only, one package per member. Resolves to
 * { order, payment, membership }.
 */
async function orderStone(user, address, packageId = PACKAGES[0].id) {
  const pkg = findPackage(packageId);
  if (!pkg) throw ApiError.badRequest('UNKNOWN_PACKAGE', 'This package is not on offer.');
  if (user.status !== 'member') {
    throw ApiError.forbidden('MEMBERSHIP_REQUIRED', 'Join the collective before ordering your package.');
  }
  if (await db.market.findStoneOrder(user.id)) {
    throw ApiError.conflict('STONE_ALREADY_ORDERED', 'You have already ordered your package.');
  }
  const { totalCents } = packagePrice(pkg);
  const result = await db.market.orderStone(user.id, pkg.id, address, { amountCents: totalCents });
  // A second request ordered first: nothing was charged twice.
  if (!result) throw ApiError.conflict('STONE_ALREADY_ORDERED', 'You have already ordered your package.');
  return { order: result.order, payment: toPayment(result.payment), membership: await getStatus(user) };
}

/** Who reads retreat applications: RETREAT_APPLICATIONS_EMAIL, else the SMTP account, else MAIL_FROM. */
function retreatInbox() {
  if (env.RETREAT_APPLICATIONS_EMAIL) return env.RETREAT_APPLICATIONS_EMAIL;
  if (env.SMTP_USER && env.SMTP_USER.includes('@')) return env.SMTP_USER;
  const match = env.MAIL_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : env.MAIL_FROM).trim();
}

/** The email the team gets for one application: who applied, how to reach them, and what they wrote. */
const applicationMail = (user, application) => ({
  subject: `Retreat application: ${user.name}`,
  text: [
    'A member has applied for the Château de Puycharnaud retreat.',
    '',
    `Name: ${user.name}`,
    `Email: ${user.email}`,
    `Phone: ${user.phone || 'not given'}`,
    `Member since: ${user.memberSince ? new Date(user.memberSince).toDateString() : 'unknown'}`,
    `Applied: ${new Date(application.createdAt).toUTCString()}`,
    '',
    'Why they would like to come:',
    application.motivation,
    '',
    `Application id: ${application.id}`,
    'Reply to the member by email. To accept or decline, set the status of this application in retreat_applications.',
  ].join('\n'),
});

/**
 * Applies for the Château de Puycharnaud retreat with a few words on why. Members only, once; the team
 * reviews applications and writes to the member. Resolves to { application, membership }.
 */
async function applyForRetreat(user, motivation) {
  if (user.status !== 'member') {
    throw ApiError.forbidden('MEMBERSHIP_REQUIRED', 'Join the collective before applying for the retreat.');
  }
  const application = await db.retreat.apply(user.id, motivation);
  if (!application) throw ApiError.conflict('ALREADY_APPLIED', 'You have already applied for the retreat.');
  // The team reads applications by email. A failed send is logged; the application is saved either way.
  await sendMail({ to: retreatInbox(), ...applicationMail(user, application) }).catch((err) =>
    logger.error('Retreat application mail failed', err),
  );
  return { application, membership: await getStatus(user) };
}

/** Pays the Collector fee for the current period in pennies. Collectors only. Resolves to { membership, payment }. */
async function payCollectorFee(user) {
  if (user.status !== 'member' || user.membershipType !== 'collector') {
    throw ApiError.forbidden('COLLECTORS_ONLY', 'The Collector fee is for Collectors.');
  }
  const { payment } = await db.pennies.pay(user.id, 'collector_fee', env.COLLECTOR_FEE_CENTS, 'collector_fee');
  return { membership: await getStatus(await db.users.findById(user.id)), payment: toPayment(payment) };
}

const MIN_DONATION_CENTS = 100;
const MAX_DONATION_CENTS = 1000000;

/**
 * A gift of pennies to Papolona from any signed-in user, apprentice or member: it goes to the ecosystem
 * like Papolona's share of sales. Resolves to { payment }.
 */
async function donate(user, amountCents) {
  if (!Number.isInteger(amountCents) || amountCents < MIN_DONATION_CENTS || amountCents > MAX_DONATION_CENTS) {
    throw ApiError.badRequest('INVALID_AMOUNT', 'Choose between 100 and 1,000,000 pennies.');
  }
  const { payment } = await db.pennies.pay(user.id, 'donation', amountCents, 'donation');
  return { payment: toPayment(payment) };
}

module.exports = {
  getStatus,
  donate,
  payCollectorFee,
  creatorStage,
  join,
  chooseType,
  activeStatus,
  orderStone,
  applyForRetreat,
  windowMs,
  PACKAGE_IDS,
  MEMBERSHIP_TYPE_IDS,
};
