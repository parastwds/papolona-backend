const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const { clueLimiter, insightsLimiter } = require('../../middleware/rateLimit');
const s = require('../common/schemas');
const clueService = require('./clue.service');

const router = Router();

const noStore = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

const generateSchema = z.object({
  // Optional: left blank, the member invites Papolona to respond to their predicament.
  question: z.string().trim().max(500).optional().default(''),
});
const interpretSchema = z.object({
  text: z
    .string({ error: 'Say what the clue means to you first.' })
    .trim()
    .min(15, 'Say a little more: split the clue into parts and say what they mean.')
    .max(5000),
  source: z.enum(['text', 'voice']),
});
const readingParams = z.object({ id: s.id });
const rating = z.coerce.number().int().min(1).max(10);
// The app asks for satisfaction only (five stars, sent as 2–10); eeriness is optional and kept when left out.
const ratingSchema = z.object({ eeriness: rating.optional(), satisfaction: rating });
const historyQuery = z.object({
  before: s.id.optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/**
 * GET /clue-string — Journal tab: can the user draw a clue now, the time left if not,
 * and their latest clue with its question.
 */
router.get('/clue-string', requireAuth, noStore, async (req, res) => {
  res.json({ success: true, data: await clueService.getStatus(req.user.id) });
});

/** GET /clue-string/history?before&limit — The user's past readings (question and clue), newest first. */
router.get('/clue-string/history', requireAuth, noStore, validate({ query: historyQuery }), async (req, res) => {
  res.json({ success: true, data: await clueService.listHistory(req.user.id, req.validatedQuery) });
});

/**
 * POST /clue-string { question? } — Journal tab START for the question the user asks (blank: Papolona responds to their predicament).
 * Draws a six-letter clue from the ANU quantum random number API. No limit, but the last clue must be
 * interpreted first (409 INTERPRET_FIRST).
 */
router.post('/clue-string', clueLimiter, requireAuth, noStore, validate({ body: generateSchema }), async (req, res) => {
  res.status(201).json({ success: true, data: await clueService.generateClue(req.user.id, req.body) });
});

/**
 * POST /clue-string/:id/interpretation { text, source } — The user's interpretation of their latest clue,
 * judged by the AI: { reading (with interpretation: verdict, parts, feedback; attempts, attemptsLeft), probation, series }.
 * A fail may be resubmitted, three judgements in all (409 NO_ATTEMPTS_LEFT); the last failed attempt fails a
 * member's series. Not once passed (409 ALREADY_JUDGED); only the latest clue (409 READING_CLOSED). 502 if the
 * judge can't be reached (no attempt used).
 */
router.post(
  '/clue-string/:id/interpretation',
  insightsLimiter,
  requireAuth,
  noStore,
  validate({ params: readingParams, body: interpretSchema }),
  async (req, res) => {
    const result = await clueService.interpret(req.user.id, req.validatedParams.id, req.body);
    res.status(201).json({ success: true, data: result });
  },
);

/**
 * POST /clue-string/:id/prompt — The split options, five minutes after the draw (409 PROMPT_NOT_YET before): { reading (with prompt: the offered splits,
 * [{ parts: [{ part, meaning }] }]), prompts: { stage, limit, used, remaining, resetsAt } }. One prompt per clue
 * (asking again returns the same splits free); 90 a month for apprentices, 30 for members (409 NO_PROMPTS_LEFT).
 * Only the latest clue, before it passes or runs out of attempts (409 READING_CLOSED / ALREADY_JUDGED /
 * NO_ATTEMPTS_LEFT). 502 if the AI can't be reached.
 */
router.post(
  '/clue-string/:id/prompt',
  insightsLimiter,
  requireAuth,
  noStore,
  validate({ params: readingParams }),
  async (req, res) => {
    res.status(201).json({ success: true, data: await clueService.prompt(req.user.id, req.validatedParams.id) });
  },
);

/** PUT /clue-string/:id/rating — { satisfaction, eeriness? } 1–10: the user's own rating of a reading. Returns the reading. */
router.put(
  '/clue-string/:id/rating',
  requireAuth,
  noStore,
  validate({ params: readingParams, body: ratingSchema }),
  async (req, res) => {
    res.json({ success: true, data: await clueService.rate(req.user.id, req.validatedParams.id, req.body) });
  },
);

module.exports = router;
