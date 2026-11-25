const { Router } = require('express');
const { requireAuth } = require('../../middleware/auth');
const db = require('../../db');

const router = Router();
router.use(requireAuth);

/**
 * GET /community/map — the world map: users per country, split into those still on probation
 * ("registered") and full members. { registered, members, countries: [{ code, registered, members }] }.
 * `code` is ISO 3166-1 alpha-2, read from the user's phone number; users without a number are only in
 * the totals. Privacy: only per-country counts leave the server, never who, never a number, and nothing
 * finer than the country (the app scatters the pins inside it at random).
 */
router.get('/map', async (_req, res) => {
  res.set('Cache-Control', 'private, max-age=300'); // changes slowly; spare the full-table count
  res.json({ success: true, data: await db.users.countryCounts() });
});

/**
 * GET /community/stats — the Discover screen's figures for the whole collective:
 * { sessions, artworks, countries, members } (readings drawn, series completed, countries by mobile
 * number, full members). Counts only.
 */
router.get('/stats', async (_req, res) => {
  res.set('Cache-Control', 'private, max-age=300');
  res.json({ success: true, data: await db.community.stats() });
});

module.exports = router;
