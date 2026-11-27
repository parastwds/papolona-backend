const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const { messageLimiter } = require('../../middleware/rateLimit');
const s = require('../common/schemas');
const membersService = require('./members.service');

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const idParams = z.object({ id: s.id });

/** GET /members/access-requests — requests to see the user's readings and NFTs, waiting: { requests }. */
router.get('/access-requests', async (req, res) => {
  res.json({ success: true, data: await membersService.pendingRequests(req.user) });
});

/** POST /members/access-requests/:id/approve — lets the asker see the user's readings and NFTs. */
router.post('/access-requests/:id/approve', messageLimiter, validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await membersService.answer(req.user, req.validatedParams.id, true) });
});

/** POST /members/access-requests/:id/deny — keeps them locked for the asker. */
router.post('/access-requests/:id/deny', messageLimiter, validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await membersService.answer(req.user, req.validatedParams.id, false) });
});

/** DELETE /members/viewers/:id — takes back a viewer's access to the user's readings and NFTs. */
router.delete('/viewers/:id', messageLimiter, validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await membersService.revoke(req.user, req.validatedParams.id) });
});

/**
 * GET /members/:id — a member's profile: { member, stats, access, dm, blocked, readings?, nfts? }; readings
 * and NFTs only with access ('self' or 'approved'). 404 MEMBER_NOT_FOUND.
 */
router.get('/:id', validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await membersService.profile(req.user, req.validatedParams.id) });
});

/** POST /members/:id/access — asks to see the member's readings and NFTs. Returns { access }. */
router.post('/:id/access', messageLimiter, validate({ params: idParams }), async (req, res) => {
  res.status(201).json({ success: true, data: await membersService.requestAccess(req.user, req.validatedParams.id) });
});

module.exports = router;
