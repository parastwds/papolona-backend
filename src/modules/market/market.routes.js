const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const { changeLimiter } = require('../../middleware/rateLimit');
const s = require('../common/schemas');
const marketService = require('./market.service');

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const listQuery = z.object({
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(60).optional(),
});
const idParams = z.object({ id: s.id });
const createSchema = z.object({
  seriesId: s.id,
  priceCents: z.coerce.number().int(),
});

/**
 * GET /market/listings?before=&limit= — open listings, newest first:
 * { listings: [{ id, priceCents, currency, status, seller: { id, name }, mine, series }], nextBefore, feePercent }.
 */
router.get('/listings', validate({ query: listQuery }), async (req, res) => {
  const { before, limit } = req.validatedQuery ?? req.query;
  res.json({
    success: true,
    data: await marketService.list(req.user, {
      before: before ? new Date(before) : null,
      limit: limit ? Number(limit) : 30,
    }),
  });
});

/** GET /market/mine — the signed-in user's listings, open and closed: { listings, feePercent }. */
router.get('/mine', async (req, res) => {
  res.json({ success: true, data: await marketService.mine(req.user) });
});

/** GET /market/listings/:id — one listing: { listing }. 404 LISTING_NOT_FOUND. */
router.get('/listings/:id', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await marketService.get(req.user, req.params.id) });
});

/**
 * POST /market/listings — { seriesId, priceCents }: puts one of the user's NFTs up for sale. Active
 * members only. Returns { listing }. 403 NOT_AN_NFT / ACTIVE_MEMBERSHIP_REQUIRED, 400 INVALID_PRICE,
 * 409 ALREADY_LISTED.
 */
router.post('/listings', changeLimiter, validate({ body: createSchema }), async (req, res) => {
  res.status(201).json({ success: true, data: await marketService.create(req.user, req.body) });
});

/** DELETE /market/listings/:id — withdraws the user's open listing. Returns { listing }. 409 LISTING_CLOSED. */
router.delete('/listings/:id', changeLimiter, validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await marketService.cancel(req.user, req.params.id) });
});

/**
 * POST /market/listings/:id/buy — buys an open listing (demo payment); the NFT becomes the buyer's.
 * Returns { listing, series, payment }. 409 OWN_LISTING / LISTING_CLOSED, 503 PAYMENTS_UNAVAILABLE.
 */
router.post('/listings/:id/buy', changeLimiter, validate({ params: idParams }), async (req, res) => {
  res.status(201).json({ success: true, data: await marketService.buy(req.user, req.params.id) });
});

module.exports = router;
