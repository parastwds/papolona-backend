const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const { insightsLimiter, journalPhotoLimiter } = require('../../middleware/rateLimit');
const { journalPhotoUpload } = require('../../middleware/upload');
const s = require('../common/schemas');
const journalService = require('./journal.service');

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store'); // personal writing: never kept by proxies
  next();
});

// Long writing and voice transcripts both fit; app.js gives /journal a larger JSON body limit to match.
const MAX_TEXT_LENGTH = 50000;
const MAX_PHOTOS = 6;

// The app sends what POST /journal/photos returned; the server checks the publicId and builds the URL itself.
const photo = z.object({
  publicId: z.string().min(1).max(300),
  width: z.number().int().positive().max(100000),
  height: z.number().int().positive().max(100000),
});

const createSchema = z
  .object({
    text: z.string().trim().max(MAX_TEXT_LENGTH).default(''),
    source: z.enum(['text', 'voice']),
    clientId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid client id.'),
    photos: z.array(photo).max(MAX_PHOTOS, `Add at most ${MAX_PHOTOS} photos.`).default([]),
  })
  // A photo on its own is an entry; with no photo there must be some text.
  .refine((v) => v.text.length > 0 || v.photos.length > 0, { message: 'Write or say something first.', path: ['text'] });
const listQuery = z.object({
  before: s.id.optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const entryParams = z.object({ id: s.id });

// Calendar marks for a stretch of days around the month on screen.
const MAX_CALENDAR_MS = 45 * 24 * 60 * 60 * 1000;
const calendarRange = z
  .object({
    from: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
    to: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  })
  .refine((v) => v.to > v.from && v.to - v.from <= MAX_CALENDAR_MS, {
    message: 'to must be after from, at most 45 days later.',
    path: ['to'],
  });

// One local day: its date, and its start and end as instants (the app knows the time zone).
// Up to 25 hours, for the day the clocks go back.
const MAX_DAY_MS = 25 * 60 * 60 * 1000;
const dayRange = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
    from: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
    to: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  })
  .refine((v) => v.to > v.from && v.to - v.from <= MAX_DAY_MS, { message: 'from and to must span one day.', path: ['to'] });

/**
 * GET /journal — Journal tab: entries newest first, with their photos and the clue each was sealed with
 * (null while open). The journal never locks: see POST /journal for how entries meet their clue.
 */
router.get('/', validate({ query: listQuery }), async (req, res) => {
  res.json({ success: true, data: await journalService.listEntries(req.user.id, req.validatedQuery) });
});

/**
 * POST /journal — Save a written or spoken entry, with up to 6 photos uploaded first via POST /journal/photos.
 * Written while today's clue is current, it is sealed to that clue at once; otherwise it waits, open, for the next draw.
 */
router.post('/', validate({ body: createSchema }), async (req, res) => {
  const { entry, created } = await journalService.createEntry(req.user.id, req.body);
  res.status(created ? 201 : 200).json({ success: true, data: { entry } });
});

/** POST /journal/photos (multipart `photo`) — Upload one photo for the entry being written. */
router.post('/photos', journalPhotoLimiter, journalPhotoUpload, async (req, res) => {
  res.status(201).json({ success: true, data: { photo: await journalService.uploadPhoto(req.user.id, req.file) } });
});

/** GET /journal/calendar?from&to — When the user wrote and drew clues in [from, to), for marking calendar days. */
router.get('/calendar', validate({ query: calendarRange }), async (req, res) => {
  res.json({ success: true, data: await journalService.getCalendar(req.user.id, req.validatedQuery) });
});

/**
 * GET /journal/insights?day&from&to — A journal day's AI reading: its entries refined into one reflection.
 * Made on first request (several seconds) and saved; reused until the day's entries change.
 */
router.get('/insights', insightsLimiter, validate({ query: dayRange }), async (req, res) => {
  res.json({ success: true, data: await journalService.getDayInsights(req.user.id, req.validatedQuery) });
});

/** POST /journal/insights { day, from, to } — Ask the AI again for a day, replacing the saved reading. */
router.post('/insights', insightsLimiter, validate({ body: dayRange }), async (req, res) => {
  res.json({ success: true, data: await journalService.getDayInsights(req.user.id, req.body, { refresh: true }) });
});

/** DELETE /journal — "Clear all": removes the entries not yet sealed by a clue. */
router.delete('/', async (req, res) => {
  res.json({ success: true, data: await journalService.clearOpenEntries(req.user.id) });
});

/** DELETE /journal/:id — Remove one entry for good. */
router.delete('/:id', validate({ params: entryParams }), async (req, res) => {
  res.json({ success: true, data: await journalService.deleteEntry(req.user.id, req.validatedParams.id) });
});

module.exports = router;
