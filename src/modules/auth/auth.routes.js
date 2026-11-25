const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const { authLimiter, resetLimiter } = require('../../middleware/rateLimit');
const { clientMeta } = require('../../utils/request');
const s = require('../common/schemas');
const authService = require('./auth.service');

const router = Router();

const registerSchema = z.object({
  name: s.name,
  email: s.email,
  password: s.password,
  phone: s.phone,
  questionnaireSubmissionId: s.id,
});

const googleSchema = z.object({
  idToken: z.string().min(20).max(5000),
  questionnaireSubmissionId: s.id.optional(),
  // Needed only when this call creates the account (Google does not share a number).
  phone: s.phone.optional(),
});

const loginSchema = z.object({ email: s.email, password: z.string().min(1, 'Please enter your password.').max(200) });
const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });
const forgotSchema = z.object({ email: s.email });
const verifySchema = z.object({ email: s.email, code: s.code });
const resetSchema = z.object({ email: s.email, code: s.code, newPassword: s.password });

/** POST /auth/register — Register screen (+ questionnaire link + legal acceptance). */
router.post('/register', authLimiter, validate({ body: registerSchema }), async (req, res) => {
  const data = await authService.register(req.body, clientMeta(req));
  res.status(201).json({ success: true, data });
});

/**
 * POST /auth/google — "Continue with Google" on Login and Signup.
 * Logs in (200), or creates the account from the questionnaire submission (201).
 * 404 ACCOUNT_NOT_FOUND = new Google user without a submission: send them to the questionnaire.
 * 400 PHONE_REQUIRED = new Google user without a mobile number: ask for it, then call again with `phone`.
 */
router.post('/google', authLimiter, validate({ body: googleSchema }), async (req, res) => {
  const { created, ...data } = await authService.googleSignIn(req.body, clientMeta(req));
  res.status(created ? 201 : 200).json({ success: true, data });
});

/** POST /auth/login — Login screen. */
router.post('/login', authLimiter, validate({ body: loginSchema }), async (req, res) => {
  res.json({ success: true, data: await authService.login(req.body, clientMeta(req)) });
});

/** POST /auth/refresh — silent token refresh (call when an API returns TOKEN_EXPIRED). */
router.post('/refresh', authLimiter, validate({ body: refreshSchema }), async (req, res) => {
  res.json({ success: true, data: await authService.refresh(req.body, clientMeta(req)) });
});

/** POST /auth/logout — sign out this device. */
router.post('/logout', requireAuth, async (req, res) => {
  await authService.logout(req.sessionId);
  res.json({ success: true, data: { message: 'Signed out.' } });
});

/** POST /auth/logout-all — sign out every device. */
router.post('/logout-all', requireAuth, async (req, res) => {
  await authService.logoutAll(req.user.id);
  res.json({ success: true, data: { message: 'Signed out of all devices.' } });
});

/** POST /auth/forgot-password — Forgot Password screen. Always 200. */
router.post('/forgot-password', resetLimiter, validate({ body: forgotSchema }), async (req, res) => {
  res.json({ success: true, data: await authService.forgotPassword(req.body, clientMeta(req)) });
});

/** POST /auth/verify-reset-code — optional: check the code before showing the new-password fields. */
router.post('/verify-reset-code', resetLimiter, validate({ body: verifySchema }), async (req, res) => {
  res.json({ success: true, data: await authService.verifyResetCode(req.body) });
});

/** POST /auth/reset-password — OTP / Reset screen. Signs out all devices. */
router.post('/reset-password', resetLimiter, validate({ body: resetSchema }), async (req, res) => {
  res.json({ success: true, data: await authService.resetPassword(req.body) });
});

module.exports = router;
