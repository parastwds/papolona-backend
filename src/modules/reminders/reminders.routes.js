const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const s = require('../common/schemas');
const { isTimeZone } = require('../../utils/zonedTime');
const { REMINDER_REPEATS } = require('../../db/postgres/schema');
const remindersService = require('./reminders.service');

const router = Router();
router.use(requireAuth);
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const fields = {
  title: z.string().trim().min(1, 'Give the reminder a title.').max(120),
  note: z.string().trim().max(1000),
  // To the minute: repeats are computed from the local hour and minute.
  remindAt: z.iso.datetime({ offset: true }).transform((v) => new Date(Math.floor(Date.parse(v) / 60000) * 60000)),
  repeat: z.enum(REMINDER_REPEATS),
  // The device's IANA zone, so repeats keep their local time across clock changes.
  timeZone: z.string().max(64).refine(isTimeZone, 'Unknown time zone.'),
};

const createSchema = z.object({
  title: fields.title,
  note: fields.note.optional(),
  remindAt: fields.remindAt,
  repeat: fields.repeat.default('none'),
  timeZone: fields.timeZone,
});

const updateSchema = z
  .object({
    title: fields.title.optional(),
    note: fields.note.optional(),
    remindAt: fields.remindAt.optional(),
    repeat: fields.repeat.optional(),
    timeZone: fields.timeZone.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

const params = z.object({ id: s.id });

/** GET /reminders — the user's reminders, upcoming first. */
router.get('/', async (req, res) => {
  res.json({ success: true, data: { reminders: await remindersService.list(req.user.id) } });
});

/** POST /reminders — { title, note?, remindAt, repeat?, timeZone }: emailed at remindAt. */
router.post('/', validate({ body: createSchema }), async (req, res) => {
  res.status(201).json({ success: true, data: { reminder: await remindersService.create(req.user.id, req.body) } });
});

/** PATCH /reminders/:id — edit, pause (active: false) or resume a reminder. */
router.patch('/:id', validate({ params, body: updateSchema }), async (req, res) => {
  const reminder = await remindersService.update(req.user.id, req.validatedParams.id, req.body);
  res.json({ success: true, data: { reminder } });
});

/** DELETE /reminders/:id */
router.delete('/:id', validate({ params }), async (req, res) => {
  await remindersService.remove(req.user.id, req.validatedParams.id);
  res.json({ success: true, data: { id: req.validatedParams.id } });
});

module.exports = router;
