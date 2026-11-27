const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const { changeLimiter } = require('../../middleware/rateLimit');
const penniesService = require('./pennies.service');

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/**
 * GET /pennies — { balance, dailyBonus: { amount, available, nextAt }, prices: { reading, cluePrompt,
 * messageRequest }, packs: [{ id, pennies, priceCents, currency, bonusPercent }], demoPayments }.
 */
router.get('/', async (req, res) => {
  res.json({ success: true, data: await penniesService.getWallet(req.user) });
});

const historyQuery = z.object({
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** GET /pennies/history?before&limit — { transactions: [{ amount, reason, balanceAfter, createdAt }], nextBefore }. */
router.get('/history', validate({ query: historyQuery }), async (req, res) => {
  res.json({ success: true, data: await penniesService.history(req.user, req.query) });
});

/** POST /pennies/daily-bonus — { claimed, wallet }. 409 BONUS_ALREADY_CLAIMED. */
router.post('/daily-bonus', changeLimiter, async (req, res) => {
  res.json({ success: true, data: await penniesService.claimDailyBonus(req.user) });
});

const packSchema = z.object({ packId: z.string().min(1).max(40) });

/**
 * POST /pennies/packs — { packId }: buys a penny pack with real money (demo payments). Returns
 * { wallet, payment }. 400 UNKNOWN_PACK, 503 PAYMENTS_UNAVAILABLE.
 */
router.post('/packs', changeLimiter, validate({ body: packSchema }), async (req, res) => {
  res.status(201).json({ success: true, data: await penniesService.buyPack(req.user, req.body.packId) });
});

module.exports = router;
