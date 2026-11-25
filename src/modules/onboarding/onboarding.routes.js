const { Router } = require('express');
const { z } = require('zod');
const validate = require('../../middleware/validate');
const { clientMeta } = require('../../utils/request');
const onboardingService = require('./onboarding.service');

const router = Router();

const submitSchema = z.object({
  version: z.number().int().positive(),
  // Single-choice answers send `optionKey`; multi-select answers send `optionKeys`.
  answers: z
    .array(
      z
        .object({
          questionKey: z.string().min(1).max(50),
          optionKey: z.string().min(1).max(50).optional(),
          optionKeys: z.array(z.string().min(1).max(50)).min(1).max(20).optional(),
        })
        .refine((a) => (a.optionKey == null) !== (a.optionKeys == null), { message: 'Send either optionKey or optionKeys.' }),
    )
    .min(1)
    .max(100),
  deviceId: z.string().max(100).optional(),
});

/** GET /onboarding/questionnaire — questions and options for the opening questionnaire. */
router.get('/questionnaire', async (_req, res) => {
  res.json({ success: true, data: await onboardingService.getActivePublic() });
});

/**
 * POST /onboarding/questionnaire/submit — public (before sign-up).
 * Scores on the server and returns a submissionId to send with /auth/register.
 */
router.post('/questionnaire/submit', validate({ body: submitSchema }), async (req, res) => {
  const data = await onboardingService.submit(req.body, clientMeta(req));
  res.status(201).json({ success: true, data });
});

module.exports = router;
