const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const { messageLimiter } = require('../../middleware/rateLimit');
const s = require('../common/schemas');
const dmsService = require('./dms.service');

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const text = z
  .string({ error: 'Write a message first.' })
  .trim()
  .min(1, 'Write a message first.')
  .max(2000, 'Keep it under 2,000 characters.');
const idParams = z.object({ id: s.id });
const userParams = z.object({ userId: s.id });
const searchQuery = z.object({ q: z.string().max(80).optional().default('') });
const pageQuery = z.object({ before: s.id.optional() });

/** GET /dms — { conversations, requests, sent, unreadCount }: the Messages tab. */
router.get('/', async (req, res) => {
  res.json({ success: true, data: await dmsService.list(req.user) });
});

/** GET /dms/search?q= — members whose name contains q (2+ letters): { users: [{ id, name, avatarUrl, state, threadId }] }. */
router.get('/search', validate({ query: searchQuery }), async (req, res) => {
  res.json({ success: true, data: await dmsService.search(req.user, req.validatedQuery.q) });
});

/** GET /dms/blocks — members the user has blocked: { users }. */
router.get('/blocks', async (req, res) => {
  res.json({ success: true, data: await dmsService.blocked(req.user) });
});

/** POST /dms/blocks — { userId }: blocks a member (declining any request from them). */
router.post('/blocks', messageLimiter, validate({ body: userParams }), async (req, res) => {
  res.status(201).json({ success: true, data: await dmsService.block(req.user, req.body.userId) });
});

/** DELETE /dms/blocks/:userId — unblocks a member. */
router.delete('/blocks/:userId', messageLimiter, validate({ params: userParams }), async (req, res) => {
  res.json({ success: true, data: await dmsService.unblock(req.user, req.validatedParams.userId) });
});

/**
 * POST /dms/requests — { userId, text }: a message request with its first message. Returns { thread }.
 * 409 ALREADY_CONNECTED / REQUEST_PENDING / REQUEST_INCOMING (details.threadId) / YOU_BLOCKED,
 * 403 CANNOT_MESSAGE, 404 USER_NOT_FOUND, 400 CANNOT_MESSAGE_SELF.
 */
router.post('/requests', messageLimiter, validate({ body: z.object({ userId: s.id, text }) }), async (req, res) => {
  res.status(201).json({ success: true, data: await dmsService.request(req.user, req.body) });
});

/** POST /dms/:id/accept — accepts a request sent to the user. Returns { thread }. */
router.post('/:id/accept', messageLimiter, validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await dmsService.answer(req.user, req.validatedParams.id, true) });
});

/** POST /dms/:id/decline — declines a request sent to the user (the sender is not told). */
router.post('/:id/decline', messageLimiter, validate({ params: idParams }), async (req, res) => {
  res.json({ success: true, data: await dmsService.answer(req.user, req.validatedParams.id, false) });
});

/** GET /dms/:id?before= — one conversation: { thread, messages (newest first), nextBefore }; marks it read. */
router.get('/:id', validate({ params: idParams, query: pageQuery }), async (req, res) => {
  res.json({
    success: true,
    data: await dmsService.get(req.user, req.validatedParams.id, { before: req.validatedQuery.before ?? null }),
  });
});

/** POST /dms/:id/messages — { text }: a message in an accepted conversation. Returns { message }. */
router.post('/:id/messages', messageLimiter, validate({ params: idParams, body: z.object({ text }) }), async (req, res) => {
  res.status(201).json({ success: true, data: await dmsService.send(req.user, req.validatedParams.id, req.body) });
});

module.exports = router;
