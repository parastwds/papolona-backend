const crypto = require('crypto');
const { Router } = require('express');
const env = require('../../config/env');
const remindersService = require('./reminders.service');

const router = Router();

/** Constant-time check of "Authorization: Bearer <CRON_SECRET>", the header Vercel Cron sends. */
function authorised(req) {
  if (!env.CRON_SECRET) return false;
  const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`);
  const given = Buffer.from(req.get('authorization') ?? '');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * GET|POST /internal/cron/reminders — emails every reminder that is due. For a scheduler (Vercel Cron,
 * cron-job.org, …) calling it every minute or few with the CRON_SECRET; off while CRON_SECRET is unset.
 */
async function run(req, res) {
  if (!env.CRON_SECRET) {
    res.status(503).json({ success: false, error: { code: 'CRON_DISABLED', message: 'CRON_SECRET is not set.' } });
    return;
  }
  if (!authorised(req)) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await remindersService.dispatchDue() });
}

router.get('/cron/reminders', run);
router.post('/cron/reminders', run);

module.exports = router;
