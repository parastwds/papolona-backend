const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const { avatarUpload } = require('../../middleware/upload');
const { changeLimiter } = require('../../middleware/rateLimit');
const { clientMeta } = require('../../utils/request');
const s = require('../common/schemas');
const usersService = require('./users.service');
const db = require('../../db');
const { publicName } = require('../artwork/artwork.service');
const billingService = require('../billing/billing.service');

const router = Router();
router.use(requireAuth);

const isTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const profileSchema = z
  .object({
    name: s.name.optional(),
    bio: z.string().trim().max(500).optional(),
    country: z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter country code, e.g. FR.').nullable().optional(),
    timezone: z.string().max(64).refine(isTimezone, 'Unknown time zone.').nullable().optional(),
    avatarUrl: z.url({ protocol: /^https$/ }).max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

const currentPassword = z.string().min(1, 'Enter your current password.').max(200);
const passwordSchema = z.object({ currentPassword, newPassword: s.password });
const emailChangeSchema = z.object({ email: s.email, currentPassword });
const phoneChangeSchema = z.object({ phone: s.phone.nullable() });
const confirmSchema = z.object({ code: s.code });

const settingsSchema = z
  .object({
    notifications: z
      .object({
        readingReminders: z.boolean().optional(),
        sequenceDeadline: z.boolean().optional(),
        productUpdates: z.boolean().optional(),
        marketing: z.boolean().optional(),
      })
      .strict()
      .optional(),
    reminderTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:mm, e.g. 09:00.').optional(),
    language: z.enum(['en']).optional(), // extend when translations exist
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

const legalSchema = z.object({ termsVersion: z.string().min(1), privacyVersion: z.string().min(1) });
const deleteSchema = z.object({ password: z.string().min(1).max(200) });
const sessionParams = z.object({ id: s.id });

/** GET /users/me — Profile screen and app start-up after login. */
router.get('/me', async (req, res) => {
  res.json({ success: true, data: await usersService.getMe(req.user) });
});

const billingSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(30).default(''),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: z.string().trim().max(200).default(''),
  city: z.string().trim().min(1).max(100),
  postcode: z.string().trim().min(1).max(20),
  country: z.string().trim().min(1).max(80),
});

/**
 * GET /users/me/billing — { billing, suggested }: the billing info every payment uses (null until saved),
 * and the account's name, email and phone to start the form with.
 */
router.get('/me/billing', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await billingService.get(req.user) });
});

/** PUT /users/me/billing — { fullName, email, phone?, addressLine1, addressLine2?, city, postcode, country }. */
router.put('/me/billing', changeLimiter, validate({ body: billingSchema }), async (req, res) => {
  res.json({ success: true, data: await billingService.save(req.user, req.body) });
});

/**
 * GET /users/me/purchases — { purchases: [{ id, purpose, amountCents, currency, createdAt, packageId,
 * seller, series }] }, newest first: memberships, the package, NFT conversions and NFTs bought.
 */
router.get('/me/purchases', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const purchases = await db.payments.listPurchases(req.user.id);
  // Sellers by their public name ("Rey R."), as on the marketplace.
  res.json({
    success: true,
    data: {
      purchases: purchases.map(({ billing, provider, status, ...p }) => ({
        ...p,
        seller: p.seller ? publicName(p.seller) : null,
      })),
    },
  });
});

/** GET /users/me/probation — Home screen: { status, readingsDone, readingsRequired, complete }. */
router.get('/me/probation', async (req, res) => {
  res.json({ success: true, data: await usersService.getProbation(req.user) });
});

/** PATCH /users/me — Edit profile: name, bio, country, timezone. Email, phone and password have their own two-step routes. */
router.patch('/me', validate({ body: profileSchema }), async (req, res) => {
  res.json({ success: true, data: await usersService.updateProfile(req.user, req.body) });
});

/** PUT /users/me/avatar — Upload or replace the profile photo (multipart/form-data, field "avatar"), stored on Cloudinary. */
router.put('/me/avatar', avatarUpload, async (req, res) => {
  res.json({ success: true, data: await usersService.uploadAvatar(req.user, req.file) });
});

/** DELETE /users/me/avatar — Remove the profile photo. */
router.delete('/me/avatar', async (req, res) => {
  res.json({ success: true, data: await usersService.removeAvatar(req.user) });
});

/*
 * Email, phone and password changes take two calls:
 *   1. request -> checks the input and emails a 6-digit code (nothing changes yet)
 *   2. confirm -> { code } applies the change
 */

/** PATCH /users/me/password — Change password, step 1 (code to account email). */
router.patch('/me/password', changeLimiter, validate({ body: passwordSchema }), async (req, res) => {
  res.json({ success: true, data: await usersService.requestPasswordChange(req.user, req.body, clientMeta(req)) });
});
/** POST /users/me/password/confirm — Change password, step 2. */
router.post('/me/password/confirm', changeLimiter, validate({ body: confirmSchema }), async (req, res) => {
  res.json({ success: true, data: await usersService.confirmPasswordChange(req.user, req.sessionId, req.body) });
});

/** POST /users/me/email — Change email, step 1 (code to the NEW email). */
router.post('/me/email', changeLimiter, validate({ body: emailChangeSchema }), async (req, res) => {
  res.json({ success: true, data: await usersService.requestEmailChange(req.user, req.body, clientMeta(req)) });
});
/** POST /users/me/email/confirm — Change email, step 2. */
router.post('/me/email/confirm', changeLimiter, validate({ body: confirmSchema }), async (req, res) => {
  res.json({ success: true, data: await usersService.confirmEmailChange(req.user, req.body) });
});

/** POST /users/me/phone — Change or remove (null) phone, step 1 (code to account email). */
router.post('/me/phone', changeLimiter, validate({ body: phoneChangeSchema }), async (req, res) => {
  res.json({ success: true, data: await usersService.requestPhoneChange(req.user, req.body, clientMeta(req)) });
});
/** POST /users/me/phone/confirm — Change phone, step 2. */
router.post('/me/phone/confirm', changeLimiter, validate({ body: confirmSchema }), async (req, res) => {
  res.json({ success: true, data: await usersService.confirmPhoneChange(req.user, req.body) });
});

/** GET / PATCH /users/me/settings — Settings screen. */
router.get('/me/settings', (req, res) => {
  res.json({ success: true, data: usersService.getSettings(req.user) });
});
router.patch('/me/settings', validate({ body: settingsSchema }), async (req, res) => {
  res.json({ success: true, data: await usersService.updateSettings(req.user, req.body) });
});

/** POST /users/me/legal/accept — re-accept updated Terms / Privacy. */
router.post('/me/legal/accept', validate({ body: legalSchema }), async (req, res) => {
  res.json({ success: true, data: await usersService.acceptLegal(req.user, req.body, clientMeta(req)) });
});

/** GET /users/me/sessions, DELETE /users/me/sessions/:id — Settings > Devices. */
router.get('/me/sessions', async (req, res) => {
  res.json({ success: true, data: await usersService.listSessions(req.user, req.sessionId) });
});
router.delete('/me/sessions/:id', validate({ params: sessionParams }), async (req, res) => {
  res.json({ success: true, data: await usersService.revokeOneSession(req.user, req.validatedParams.id) });
});

/** DELETE /users/me — Settings > Delete account (password confirmation). */
router.delete('/me', validate({ body: deleteSchema }), async (req, res) => {
  res.json({ success: true, data: await usersService.deleteAccount(req.user, req.body) });
});

module.exports = router;
