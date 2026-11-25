const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const s = require('../common/schemas');
const artworkService = require('./artwork.service');

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const wallQuery = z.object({
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(60).optional(),
});
const idParams = z.object({ id: s.id });

/**
 * GET /artwork/wall?before=&limit= — the collective artwork, newest first:
 * { tiles: [series + { badges, owner: { id, name } }], nextBefore } (null on the last page).
 */
router.get('/wall', validate({ query: wallQuery }), async (req, res) => {
  const { before, limit } = req.validatedQuery ?? req.query;
  res.json({
    success: true,
    data: await artworkService.wall({ before: before ? new Date(before) : null, limit: limit ? Number(limit) : 30 }),
  });
});

/** GET /artwork/wall/:id — one tile opened: { tile, readings: [{ clue, interpretation, parts, tileIndex }] }. */
router.get('/wall/:id', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await artworkService.tile(req.params.id) });
});

/** GET /artwork/members/:id — a member's gallery: { member: { id, name, memberSince }, tiles }. */
router.get('/members/:id', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await artworkService.memberGallery(req.params.id) });
});

/** GET /artwork/badges/me — the signed-in user's badges: { badges: [{ badge, seriesId, awardedAt }] }. */
router.get('/badges/me', async (req, res) => {
  res.json({ success: true, data: await artworkService.myBadges(req.user.id) });
});

module.exports = router;
