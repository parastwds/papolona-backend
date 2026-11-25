const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const { changeLimiter } = require('../../middleware/rateLimit');
const s = require('../common/schemas');
const { MINT_CHOICES } = require('../../db/postgres/schema');
const seriesService = require('./series.service');

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const startSchema = z.object({
  length: z.union(seriesService.OPTIONS.map((o) => z.literal(o.length)), {
    error: `Choose ${seriesService.OPTIONS.map((o) => o.length).join(', ')} readings.`,
  }),
});

const seriesParams = z.object({ id: s.id });
const mintChoiceSchema = z.object({ choice: z.enum(MINT_CHOICES) });

/**
 * GET /series/options — the series picker: { options: [{ length, label, rows, cols, rarity, badge,
 * nftEligible, minDays }], publish: { price: { amountCents, currency }, demoPayments } }.
 */
router.get('/options', (_req, res) => {
  res.json({ success: true, data: { options: seriesService.options(), publish: seriesService.publishInfo() } });
});

/**
 * GET /series/active — { series } or { series: null }. A series past its deadline is abandoned (its NFT
 * lost) when read, so this never returns one that has run out of time.
 */
router.get('/active', async (req, res) => {
  res.json({ success: true, data: { series: await seriesService.getActive(req.user.id) } });
});

/** GET /series — the Collect tab: active and completed series, newest first. */
router.get('/', async (req, res) => {
  res.json({ success: true, data: { series: await seriesService.list(req.user.id) } });
});

/**
 * POST /series — { length: 1 | 2 | 3 | 6 | 12 | 24 }: starts a series. Members only, one at a time.
 * 403 MEMBERSHIP_REQUIRED, 409 SERIES_ACTIVE.
 */
router.post('/', validate({ body: startSchema }), async (req, res) => {
  res.status(201).json({ success: true, data: { series: await seriesService.start(req.user, req.body) } });
});

/**
 * POST /series/:id/publish — makes a completed emblem series public: it joins the collective artwork, free,
 * without being for sale. Returns { series, payment: null }. 404 SERIES_NOT_FOUND, 409 SERIES_NOT_COMPLETED /
 * ALREADY_PUBLISHED, 403 NOT_PUBLISHABLE (singles and twins).
 */
router.post('/:id/publish', changeLimiter, validate({ params: seriesParams }), async (req, res) => {
  res.status(201).json({ success: true, data: await seriesService.publish(req.user, req.params.id) });
});

/**
 * DELETE /series/:id/publish — makes the series private again: off the collective artwork. Returns { series }.
 * 404 SERIES_NOT_FOUND, 409 LISTED_FOR_SALE (a series for sale stays public; withdraw it first).
 */
router.delete('/:id/publish', changeLimiter, validate({ params: seriesParams }), async (req, res) => {
  res.json({ success: true, data: await seriesService.unpublish(req.user, req.params.id) });
});

const convertSchema = z.object({ poc: z.boolean().default(false) });

/**
 * POST /series/:id/convert — { poc? }: pays the conversion price (demo) and converts a completed Triple,
 * Hexa, Dozen or Double Dozen emblem into an NFT, optionally joining the POC ecosystem. Keeps the member
 * active. Returns { series, payment }. 403 NOT_MINT_ELIGIBLE, 409 SERIES_NOT_COMPLETED / ALREADY_CONVERTED,
 * 503 PAYMENTS_UNAVAILABLE.
 */
router.post('/:id/convert', changeLimiter, validate({ params: seriesParams, body: convertSchema }), async (req, res) => {
  res.status(201).json({ success: true, data: await seriesService.convert(req.user, req.params.id, req.body) });
});

/**
 * PUT /series/:id/mint-choice — { choice: 'keep' | 'mint' | 'mint_poc' } for a completed emblem series.
 * 'mint' and 'mint_poc' convert it (paid, as POST /convert). Returns { series }. 403 NOT_MINT_ELIGIBLE,
 * 409 ALREADY_CONVERTED.
 */
router.put('/:id/mint-choice', validate({ params: seriesParams, body: mintChoiceSchema }), async (req, res) => {
  const series = await seriesService.setMintChoice(req.user, req.params.id, req.body.choice);
  res.json({ success: true, data: { series } });
});

module.exports = router;
