const { z } = require('zod');
const db = require('../../db');
const { countryOfPhone } = require('../../utils/phoneCountry');

const email = z
  .string({ error: 'Email is required.' })
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ error: 'Please enter a valid email address.' }));

// bcrypt only uses the first 72 bytes, so longer passwords are rejected rather than silently truncated.
const password = z
  .string({ error: 'Password is required.' })
  .min(8, 'Use at least 8 characters.')
  .max(72, 'Use at most 72 characters.')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Use at least one letter and one number.');

const name = z.string({ error: 'Name is required.' }).trim().min(2, 'Name looks too short.').max(80);

const code = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your email.');

// A record id (a UUID).
const id = z.string().refine((v) => db.isValidId(v), 'Invalid id.');

// International format with country code. Spaces, dashes, dots and brackets are stripped first.
// The country code must be a real one: the user's place on the world map is read from it.
const phone = z
  .string({ error: 'Mobile number is required.' })
  .transform((v) => v.replace(/[\s\-().]/g, ''))
  .pipe(
    z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/, 'Enter your number with country code, e.g. +919876543210.')
      .refine((v) => countryOfPhone(v) !== null, 'That country code is not recognised. Start with your country code, e.g. +91.'),
  );

module.exports = { email, password, name, code, id, phone };
