const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const { changeLimiter } = require('../../middleware/rateLimit');
const membershipService = require('./membership.service');

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/**
 * GET /membership — { status, isMember, memberSince, probation, free: true, price: null, canJoin,
 * active: { isActive, stoneOrdered, lastConversionAt, activeUntil, windowDays },
 * stone: { priceCents, postageCents, totalCents, currency, order } }: the membership screen and the Home card.
 */
router.get('/', async (req, res) => {
  res.json({ success: true, data: await membershipService.getStatus(req.user) });
});

// Every new member chooses a membership.
const typeSchema = z.object({ type: z.enum(membershipService.MEMBERSHIP_TYPE_IDS) });

/**
 * POST /membership/join — { type }: makes a user who has finished probation a member with the membership
 * they chose ('explorer' | 'creator' | 'collector'; required), charging the first month of a paid one
 * (demo). Returns { membership, payment }. 400 without a type, 403 PROBATION_INCOMPLETE,
 * 409 ALREADY_MEMBER, 503 PAYMENTS_UNAVAILABLE.
 */
const join = async (req, res) => {
  res.status(201).json({ success: true, data: await membershipService.join(req.user, req.body.type) });
};
router.post('/join', changeLimiter, validate({ body: typeSchema }), join);
// The old paid checkout: app builds from before membership was free still call it.
router.post('/checkout', changeLimiter, validate({ body: typeSchema }), join);

/**
 * PUT /membership/type — { type }: switches a member's membership at any time; each switch to a paid one
 * charges its first month again (demo). Returns { membership, payment }. 403 MEMBERSHIP_REQUIRED,
 * 409 SAME_MEMBERSHIP.
 */
router.put('/type', changeLimiter, validate({ body: typeSchema }), async (req, res) => {
  res.json({ success: true, data: await membershipService.chooseType(req.user, req.body.type) });
});


/**
 * POST /membership/donation — { amountCents }: a gift to Papolona from any signed-in user (demo payments).
 * Returns { payment }. 400 INVALID_AMOUNT, 503 PAYMENTS_UNAVAILABLE.
 */
const donationSchema = z.object({ amountCents: z.number().int() });
router.post('/donation', changeLimiter, validate({ body: donationSchema }), async (req, res) => {
  res.status(201).json({ success: true, data: await membershipService.donate(req.user, req.body.amountCents) });
});

/**
 * POST /membership/collector-fee — pays the Collector fee for the current period (demo payments).
 * Returns { membership, payment }. 403 COLLECTORS_ONLY, 503 PAYMENTS_UNAVAILABLE.
 */
router.post('/collector-fee', changeLimiter, async (req, res) => {
  res.status(201).json({ success: true, data: await membershipService.payCollectorFee(req.user) });
});

const stoneSchema = z.object({
  recipientName: z.string().trim().min(1).max(120),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: z.string().trim().max(200).default(''),
  city: z.string().trim().min(1).max(100),
  postcode: z.string().trim().min(1).max(20),
  country: z.string().trim().min(1).max(80),
  // Which package; app builds from before packages send none and get the Sensitisation Package.
  package: z.enum(membershipService.PACKAGE_IDS).default(membershipService.PACKAGE_IDS[0]),
});

/**
 * POST /membership/stone — { package?, recipientName, addressLine1, addressLine2?, city, postcode, country }:
 * orders the Sensitisation Package active membership asks for ('stone_triptych'; demo payment: price +
 * postage). Returns { order, payment, membership }. 403 MEMBERSHIP_REQUIRED, 409 STONE_ALREADY_ORDERED,
 * 503 PAYMENTS_UNAVAILABLE.
 */
router.post('/stone', changeLimiter, validate({ body: stoneSchema }), async (req, res) => {
  const { package: packageId, ...address } = req.body;
  res.status(201).json({ success: true, data: await membershipService.orderStone(req.user, address, packageId) });
});

const retreatSchema = z.object({ motivation: z.string().trim().min(20).max(2000) });

/**
 * POST /membership/retreat — { motivation }: applies for the Château de Puycharnaud retreat (no payment).
 * Returns { application, membership }. 403 MEMBERSHIP_REQUIRED, 409 ALREADY_APPLIED.
 */
router.post('/retreat', changeLimiter, validate({ body: retreatSchema }), async (req, res) => {
  res.status(201).json({ success: true, data: await membershipService.applyForRetreat(req.user, req.body.motivation) });
});

module.exports = router;
