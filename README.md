# Papolona API — Phase 1: Onboarding & Account

Node.js + Express 5 + PostgreSQL (Drizzle ORM; Neon in production). Serves the 12 Onboarding & Account screens of the Papolona Android/iOS app.

## Quick start

```bash
npm install
cp .env.example .env        # then set DATABASE_URL, JWT_ACCESS_SECRET, OTP_PEPPER
npm run db:migrate          # create / update the tables (safe to re-run)
npm run seed                # questionnaire, app config (idempotent)
npm run dev                 # http://localhost:4000/api/v1
npm test                    # full test suite on an in-memory Postgres (PGlite), nothing to install
```

## Database

`DATABASE_URL` is a `postgres://` or `postgresql://` URL (on Neon, use the pooled URL).

Services never touch the database directly. They call the repositories in `src/db` (`db.users`, `db.sessions`, `db.journal`, …),
which return plain objects (ids are UUIDv7 strings). Unique-key clashes surface as `DuplicateError` from `src/db/errors.js`.

The schema lives in `src/db/postgres/schema.js` (Drizzle). After changing it, run `npm run db:generate` to write a
new SQL migration into `./drizzle`, review it, commit it, then `db:migrate` each database. Migrations never run on
server start-up. Expired pending codes are not removed automatically on Postgres (no TTL index); they still stop working
at `expiresAt`.

Generate secrets with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
Without `SMTP_HOST`, emails (welcome, reset codes) are printed to the console.

Import `postman/Papolona-Phase1.postman_collection.json` into Postman. Login and register save the tokens automatically.

## Screen → endpoint map

| # | Screen | Endpoint(s) | Auth |
|---|---|---|---|
| 1 | Splash | `GET /app/config` (force update, maintenance, current legal versions) | – |
| 2 | Welcome | text is in the app | – |
| 3 | Worldview questionnaire | `GET /onboarding/questionnaire`, `POST /onboarding/questionnaire/submit` | – |
| 4 | Cohort result | returned by `submit` (null when `showCohortToUser` is false) | – |
| 5 | Origin story / video | text and video link are in the app | – |
| 6 | Register | `POST /auth/register` | – |
| 7 | Login | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/logout-all` | – / Bearer |
| 8 | Forgot password | `POST /auth/forgot-password` | – |
| 9 | OTP / reset password | `POST /auth/verify-reset-code` (optional), `POST /auth/reset-password` | – |
| 10 | Terms & privacy | text is in the app; its versions come from `GET /app/config` (`legal`), re-acceptance via `POST /users/me/legal/accept`. When the text changes, bump `legal` in the app config (`db.appConfig.setLegalVersions`) | – / Bearer |
| 11 | Profile / edit profile | `GET /users/me`, `PATCH /users/me`, `PUT /users/me/avatar`, `DELETE /users/me/avatar`, `POST /users/me/email` (+`/confirm`), `POST /users/me/phone` (+`/confirm`) | Bearer |
| 12 | Settings | `GET/PATCH /users/me/settings`, `PATCH /users/me/password` + `POST /users/me/password/confirm`, `GET /users/me/sessions`, `DELETE /users/me/sessions/:id`, `DELETE /users/me` | Bearer |
| 13 | Journal: generate clue | `GET /clue-string` → `{ canGenerate, lastClue: { id, clue, question, generatedAt, interpretation, attempts, attemptsLeft, maxAttempts, … }, prompts }` (lastClue null before the first clue; canGenerate false while it waits for its interpretation); `POST /clue-string { question? }` (up to 500 chars, blank allowed) → `{ id, clue: "ECBFAD", question, generatedAt, series }`: six letters (A–Z): ANU quantum random hex is read as bytes, and bytes that are ASCII letters are kept. No limit on readings, but the last clue must be interpreted first (409 `INTERPRET_FIRST`); `GET /clue-string/history?before&limit` → `{ readings: [{ id, clue, question, generatedAt }], nextCursor }` | Bearer |
| 13b | Journal: interpret clue (AI judge) | `POST /clue-string/:id/interpretation { text, source: text|voice }` (15–5000 chars) → `{ reading: { …, interpretation: { text, source, verdict: pass|fail, parts: [{ part, meaning }], feedback, judgedAt }, attempts, attemptsLeft }, probation, series }`. The AI judges the split-and-combine, not belief. A failed reading may be reviewed and resubmitted: three judgements in all (409 `NO_ATTEMPTS_LEFT`), or the user may move on to a new reading. When the last attempt fails, an apprentice starts a new reading, and a member's series the reading was drawn in has failed (status `failed`). Not once passed (409 `ALREADY_JUDGED`), latest clue only (409 `READING_CLOSED`); 502 `AI_UNAVAILABLE` saves nothing and uses no attempt. A reading must be passed within `READING_WINDOW_HOURS` (12) of its draw, or it fails (409 `READING_EXPIRED`; readings carry `deadlineAt` and `expired`), and a member's series fails with it; an email warns when the last hour starts (series deadline emails). Each pass counts toward graduation (`GET /users/me/probation` counts passes). | Bearer |
| 14 | Journal | `GET /journal?before&limit` → `{ entries, nextCursor }`; `POST /journal { text, source, clientId, photos? }` (text up to 50,000 chars, may be empty with photos; up to 6 photos from `POST /journal/photos`, multipart `photo`, up to `JOURNAL_PHOTO_MAX_MB`). Each entry is `{ id, clientId, text, source, photos: [{ publicId, url, width, height }], createdAt, clue }`. The journal never locks: an entry written while the latest clue is current is sealed to it at once, otherwise it stays open (`clue: null`) until the next draw seals it. `GET /journal/calendar?from&to` (≤ 45 days) → `{ entries: [createdAt], readings: [generatedAt] }`; `DELETE /journal/:id`, `DELETE /journal` (open entries) also delete their photos | Bearer |

Plus `GET /health` for uptime monitoring. All paths are under `/api/v1`.

## Response format

```json
{ "success": true,  "data": { ... } }
{ "success": false, "error": { "code": "EMAIL_TAKEN", "message": "...", "details": ... } }
```

The app should branch on `error.code`, never on `message`. Validation errors return `VALIDATION_ERROR` with `details: [{ field, message }]`, one message per field, so the app can show them under each input.

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR`, `INVALID_JSON` | 400 | bad input |
| `QUESTIONNAIRE_INVALID` / `INVALID_ANSWERS` | 400 | missing or invalid questionnaire data |
| `QUESTIONNAIRE_OUTDATED` | 409 | app has an old questionnaire version → refetch |
| `QUESTIONNAIRE_ALREADY_USED` | 409 | submission already linked → redo questionnaire |
| `EMAIL_TAKEN` | 409 | register with an existing email |
| `LEGAL_VERSION_OUTDATED` | 409 | terms/privacy changed; `details` has current versions |
| `INVALID_CREDENTIALS` | 401 | wrong email or password (identical for both) |
| `ACCOUNT_LOCKED` | 429 | 5 failed logins → 15-min lock; `details.retryAfterSeconds` |
| `ACCOUNT_SUSPENDED` | 403 | admin suspended |
| `TOKEN_MISSING` / `TOKEN_INVALID` | 401 | no or bad access token |
| `TOKEN_EXPIRED` | 401 | call `/auth/refresh`, then retry |
| `SESSION_REVOKED` | 401 | logged out / password changed → go to Login |
| `REFRESH_TOKEN_INVALID` / `REFRESH_TOKEN_REUSED` | 401 | go to Login |
| `RESET_CODE_INVALID` | 400 | wrong/expired code; `details.attemptsRemaining` when wrong |
| `PASSWORD_INCORRECT` / `PASSWORD_UNCHANGED` | 400 | change password / change email / delete account |
| `CODE_INVALID` | 400 | wrong/expired change-confirmation code; `details.attemptsRemaining` when wrong |
| `CODE_RECENTLY_SENT` | 429 | asked for a new change code within 30 s; `details.retryAfterSeconds` |
| `EMAIL_UNCHANGED` / `PHONE_UNCHANGED` | 400 | new value is the same as the current one |
| `PHONE_TAKEN` | 409 | another account uses this phone number |
| `NO_ATTEMPTS_LEFT` | 409 | the reading has used all three judgements; start a new reading |
| `READING_EXPIRED` | 409 | the reading was not passed within 12 hours of its draw, so it has failed; start a new reading |
| `CLUE_NOT_CONFIGURED` | 503 | `QRNG_API_KEY` is not set |
| `CLUE_SOURCE_UNAVAILABLE` | 502 | the ANU quantum number API failed or rejected the key |
| `INVALID_PHOTO` | 400 | a journal entry refers to a photo that is not one of the user's uploads |
| `UNSUPPORTED_FILE_TYPE` / `FILE_TOO_LARGE` | 400 / 413 | avatar or journal photo is not JPG/PNG/WebP, or too big |
| `*_RATE_LIMITED` | 429 | too many requests from this IP |

## Key flows

**Questionnaire before sign-up.** The app submits answers and the server scores them (weights never leave the server). The response gives a `submissionId`, which `/auth/register` requires. Each submission can be linked to one account only. The cohort is fixed at that point; the user cannot change it.

**Register.** Registering counts as acceptance of the current Terms and Privacy Policy versions from `/app/config`; the client does not send them. Each acceptance is written to an append-only `LegalAcceptance` log with IP, user agent and timestamp. New accounts start with `status: "probation"`.

**Tokens.**
- The access token is a JWT that lasts 15 minutes. Send it as `Authorization: Bearer <token>`.
- The refresh token is opaque, lasts 30 days, is stored hashed and **rotates on every use**. Store it in `expo-secure-store`.
- Reusing an old refresh token revokes all sessions from that login, which protects against token theft. **The app must run only one refresh call at a time.**
- Logout and password changes take effect immediately, because every request checks that the session is still active.

**Password reset.**
- `forgot-password` always returns the same response, so it can't be used to discover which emails have accounts.
- The 6-digit code is stored as an HMAC and expires after 10 minutes. It allows 5 attempts, then it is burned. It works once only. A resend has a 30-second cooldown.
- A successful reset signs out all devices and sends a "password changed" email.

**Re-acceptance.** When a new Terms or Privacy version is published, `GET /users/me` returns `legal.needsReacceptance: true`. The app shows the Terms screen and then calls `POST /users/me/legal/accept`.

**Edit profile.** `PATCH /users/me` (JSON) updates any of `name`, `bio`, `country`, `timezone` immediately.

**Email, phone and password changes need an emailed code.** Each is two calls: step 1 checks the input and emails a 6-digit code (nothing changes yet); step 2 sends `{ "code": "123456" }` and applies the change.

| Change | Step 1 | Code sent to | Step 2 |
|---|---|---|---|
| Password | `PATCH /users/me/password` `{ currentPassword, newPassword }` | account email | `POST /users/me/password/confirm` |
| Email | `POST /users/me/email` `{ email, currentPassword }` | the **new** email (proves the user owns it) | `POST /users/me/email/confirm` |
| Phone | `POST /users/me/phone` `{ phone }` (`null` removes it) | account email | `POST /users/me/phone/confirm` |

- Step 1 returns `{ message, sentTo (masked), expiresInMinutes, resendAfterSeconds }`.
- Codes follow the reset-code rules: HMAC-stored, 10-minute expiry, 5 attempts, single use, 30-second resend cooldown (`429 CODE_RECENTLY_SENT` with `details.retryAfterSeconds`). A new request replaces the previous one of the same kind, and a code only confirms its own kind of change.
- For a password change only the new password's bcrypt hash is stored while waiting. Confirming keeps this device signed in and signs out all others.
- Any pending change is cancelled when the password changes (including a reset), so a code requested before a takeover is recovered can't be used afterwards.
- After the change: the old email gets an "email changed" notice and the new one counts as verified; phone and password changes send a notice to the account email.
- `phone` must include the country code (e.g. `+919876543210`) and is unique per account (`PHONE_TAKEN`).
- A mobile number is required to create an account: `/auth/register` takes `phone`, and `/auth/google` answers `PHONE_REQUIRED` (400) for a new user until it is sent. Its country code must be a real one; the country is stored and feeds `GET /community/map` (users per country, on probation vs members).

**Profile photo.** `PUT /users/me/avatar` takes `multipart/form-data` with one file in the `avatar` field: JPG, PNG or WebP, up to `AVATAR_MAX_MB` (4 MB by default; Vercel rejects requests over 4.5 MB). The type is checked from the file's bytes, not its name. The photo is uploaded to Cloudinary (folder `CLOUDINARY_FOLDER`), cropped to 512×512 around the face, and its HTTPS URL comes back in `user.profile.avatarUrl`. Uploading again replaces it and deletes the old one from Cloudinary; `DELETE /users/me/avatar` removes it. Until the three `CLOUDINARY_*` keys are set, uploads return `503 UPLOADS_UNAVAILABLE`. Tests never call Cloudinary.

**Account deletion.** `DELETE /users/me` asks for the password. It anonymises name, email, phone and profile, deletes the uploaded photo, and revokes all sessions. Apple requires in-app deletion. The cohort and questionnaire answers are kept as pseudonymous research data, **so the client's privacy policy must state this**.

## Security summary

- bcrypt (12 rounds); passwords between 8 and 72 characters, with at least one letter and one number
- Timing-safe login, so response time doesn't reveal whether an email is registered
- Account lockout after 5 failed attempts, plus per-IP rate limits (memory store; switch to Redis when running several instances)
- Zod validation strips unknown fields and blocks NoSQL operator injection; profile updates can't change `role` or `status`
- Helmet headers, a 100 KB body limit, CORS allowlist, `TRUST_PROXY` for running behind Nginx

## Project structure

```
src/
  app.js, server.js
  config/      env (validated)
  db/          repositories: postgres/ (Drizzle schema + migrations in ../drizzle), shared defaults and errors
  middleware/  auth, validate, rateLimit, upload, error
  modules/
    app/         health + app config (incl. current legal versions)
    onboarding/  questionnaire + server-side scoring
    auth/        register, login, refresh, logout, password reset, sessions
    users/       profile, code-confirmed email/phone/password changes, settings, devices, legal, delete account
  seed/        questionnaire and app config
  utils/       ApiError, security (JWT, hashing, codes), mailer, logger, storage (Cloudinary photos)
tests/         onboarding, auth, users (Jest + Supertest)
```

## Waiting on the client

- Three cohort names, real questions, weights, tie-break order, and whether users see their cohort → `src/seed/data.js` (add a **new version**; don't edit v1 once real users have answered)
- Origin-story video URL and final copy, Terms and Privacy text from their lawyer
- Email provider and sender domain. Brevo's HTTPS API (`BREVO_API_KEY`) works on hosts that block SMTP ports, such as Render's free plan; any SMTP provider works elsewhere

## Not in this phase (deliberate)

- Email verification: easy to add once the client decides whether verification is required before probation starts
- Admin endpoints for editing the questionnaire and app config: part of the Admin module; use the seed script until then
- Research consent (screen 86) and push-notification tokens: added with their modules
