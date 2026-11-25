const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const statsService = require('./stats.service');

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store'); // personal activity: never kept by proxies
  next();
});

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a real date.');

const statsQuery = z.object({
  unit: z.enum(['day', 'month', 'year']),
  from: localDate.optional(),
  to: localDate.optional(),
  // The device's UTC offset in minutes (UTC+05:30 is 330), so days are cut at the user's midnight.
  tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
});

/**
 * GET /stats?unit=day|month|year&from&to&tzOffset — Home screen graphs: readings, pass/fail, notes and
 * average eeriness/satisfaction (the user's and the AI's) per bucket, totals for the range, and streaks.
 * Without `from` the range starts at the first activity; without `to` it ends today.
 */
router.get('/', validate({ query: statsQuery }), async (req, res) => {
  res.json({ success: true, data: await statsService.getStats(req.user.id, req.validatedQuery) });
});

module.exports = router;
