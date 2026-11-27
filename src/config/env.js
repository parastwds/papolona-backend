require('dotenv').config({ quiet: true });
const { z } = require('zod');

const bool = (def) =>
  z
    .enum(['true', 'false'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  // The PostgreSQL database (Neon in production).
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    // pglite://<folder> runs a local database in a folder, for development without a Postgres server.
    .regex(/^(postgres(ql)?|pglite):\/\//i, 'Use a postgres:// or postgresql:// URL (or pglite://<folder> locally)'),
  CORS_ORIGINS: z.string().default('*'),
  TRUST_PROXY: bool(false),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Presenting the just-rotated refresh token again within this many seconds returns the session's
  // current pair (a retry after a crash or reload mid-refresh) instead of revoking it as theft. 0 = off.
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(60),
  OTP_PEPPER: z.string().min(16, 'OTP_PEPPER must be at least 16 characters'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  RESET_CODE_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  RESET_CODE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  RESET_CODE_RESEND_SECONDS: z.coerce.number().int().nonnegative().default(30),
  LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

  RATE_LIMIT_ENABLED: bool(true),

  // Google sign-in: the OAuth "Web application" client ID, which is the audience of the app's ID tokens.
  // Unset = POST /auth/google answers 503 GOOGLE_NOT_CONFIGURED.
  GOOGLE_WEB_CLIENT_ID: z.string().optional(),

  // Profile photos are stored on Cloudinary. Uploads are refused until all three are set.
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default('papolona/avatars'),
  // Vercel rejects request bodies over 4.5 MB, so keep this at 4 or below there.
  AVATAR_MAX_MB: z.coerce.number().positive().max(20).default(4),
  // Journal photos go to `${CLOUDINARY_JOURNAL_FOLDER}/<userId>`, so an entry can only attach the user's own uploads.
  CLOUDINARY_JOURNAL_FOLDER: z.string().default('papolona/journal'),
  // The same 4.5 MB Vercel request limit applies there; the app should shrink photos before uploading.
  JOURNAL_PHOTO_MAX_MB: z.coerce.number().positive().max(20).default(8),

  // Brevo HTTPS email API; when set it is used instead of SMTP (for hosts that block SMTP ports).
  BREVO_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: bool(false),
  MAIL_FROM: z.string().default('Papolona <no-reply@papolona.com>'),

  // ANU Quantum Random Numbers, used for Journal clue strings. Unset key = POST /clue-string answers 503.
  QRNG_API_URL: z.string().url().default('https://api.quantumnumbers.anu.edu.au?length=10&type=hex8&size=2'),
  QRNG_API_KEY: z.string().optional(),
  // There is no limit on readings, but each clue must be interpreted before the next is drawn.
  // The apprenticeship (probation): it lasts at least PROBATION_DAYS from sign-up, and completes once the
  // passed readings reach at least PROBATION_READINGS and are a multiple of PROBATION_STEP (30, 33, 36…).
  PROBATION_DAYS: z.coerce.number().int().nonnegative().default(28),
  PROBATION_READINGS: z.coerce.number().int().positive().default(30),
  PROBATION_STEP: z.coerce.number().int().positive().default(3),

  // Membership is free once probation is complete. Members pay only to publish a completed series to
  // the public collective artwork.
  PAYMENTS_CURRENCY: z.string().length(3).default('USD'),
  // No real payment provider yet: true lets POST /series/:id/publish succeed without charging anyone.
  // false = publishing answers 503 PAYMENTS_UNAVAILABLE. Turn off before launch until a real provider is added.
  DEMO_PAYMENTS: bool(false),
  // Active membership: a member stays active this many days after each NFT conversion they pay for.
  ACTIVE_WINDOW_DAYS: z.coerce.number().int().positive().default(60),
  // The Sensitisation Package active membership asks for (provisional price, in PACKAGE_CURRENCY), plus
  // postage: the meditation stone, the Enigma Prism Triptych, initiation materials and a first advanced
  // reading sequence.
  PACKAGE_STONE_TRIPTYCH_CENTS: z.coerce.number().int().positive().default(15000),
  STONE_POSTAGE_CENTS: z.coerce.number().int().nonnegative().default(1500),
  PACKAGE_CURRENCY: z.string().length(3).default('EUR'),
  // The Château de Puycharnaud retreat: by application, a few places a year. Its price range (provisional)
  // is shown; nothing is charged when applying.
  RETREAT_DAYS: z.coerce.number().int().positive().default(3),
  RETREAT_PRICE_FROM_CENTS: z.coerce.number().int().positive().default(60000),
  RETREAT_PRICE_TO_CENTS: z.coerce.number().int().positive().default(150000),
  // The membership chosen at graduation, per month, in MEMBERSHIP_CURRENCY (provisional prices). Explorer
  // is free after graduation; Collector is free to join (its obligations are in membership.service).
  // Demo payments charge the first month.
  MEMBERSHIP_EXPLORER_CENTS: z.coerce.number().int().nonnegative().default(0),
  MEMBERSHIP_CREATOR_CENTS: z.coerce.number().int().nonnegative().default(2500),
  MEMBERSHIP_COLLECTOR_CENTS: z.coerce.number().int().nonnegative().default(0),
  MEMBERSHIP_CURRENCY: z.string().length(3).default('EUR'),
  // Creators and Collectors keep their membership by meeting its terms within each period of this many days,
  // counted from when they chose it; otherwise they return to Explorer. Demo values while no payment
  // method is set up:
  STANDING_PERIOD_DAYS: z.coerce.number().int().positive().default(60),
  // Collector: buy a member's NFT and keep at least this wallet balance, or pay the Collector fee.
  COLLECTOR_MIN_WALLET_CENTS: z.coerce.number().int().nonnegative().default(10000),
  COLLECTOR_FEE_CENTS: z.coerce.number().int().positive().default(5000),
  // A Collector who buys at least this much art (NFTs from members) in 12 months keeps the membership
  // for those 12 months, without the fee or the wallet minimum.
  COLLECTOR_ART_YEAR_CENTS: z.coerce.number().int().positive().default(1000000),
  // Creator: the deposit suggested at the start of each period, for the conversions to come.
  CREATOR_DEPOSIT_CENTS: z.coerce.number().int().positive().default(9000),
  // Where each retreat application is emailed. Unset = the SMTP account (SMTP_USER), else MAIL_FROM's address.
  RETREAT_APPLICATIONS_EMAIL: z.string().email().optional(),
  // Where a member's contest of a failed judgement is emailed (Papolona's owner). Unset = the SMTP account
  // (SMTP_USER), else MAIL_FROM's address. A reading that failed all its attempts may be contested within
  // CONTEST_WINDOW_DAYS of its last judgement.
  CONTEST_EMAIL: z.string().email().optional(),
  CONTEST_WINDOW_DAYS: z.coerce.number().positive().default(90),
  // Papolona's share of each marketplace sale, in percent; the seller gets the rest.
  MARKET_FEE_PERCENT: z.coerce.number().int().min(0).max(100).default(50),
  // A new listing is first an auction for Collectors, for this many days; the highest bid wins. With no
  // bids by then it opens to everyone at its starting price.
  AUCTION_COLLECTOR_DAYS: z.coerce.number().positive().default(30),
  // Each bid must beat the highest so far by at least this percent of it (and at least $1).
  AUCTION_MIN_INCREMENT_PERCENT: z.coerce.number().min(0).max(100).default(5),
  // A reading must be completed (passed) within this long of drawing its clue, or it fails; a member's
  // series it was drawn in fails with it. A warning goes out when the last hour starts.
  READING_WINDOW_HOURS: z.coerce.number().positive().default(12),

  // The model that refines journal days and asks reflective questions about them.
  // Claude when ANTHROPIC_API_KEY is set; otherwise Ollama; empty OLLAMA_URL too = insights answer 503.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-5-5'),
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('beam:cloud'),
  AI_TIMEOUT_SECONDS: z.coerce.number().positive().default(90),

  // Reminder emails. An always-on server (src/server.js) checks for due reminders every
  // REMINDER_POLL_SECONDS (0 = off). Serverless hosts instead need a scheduler calling
  // /api/v1/internal/cron/reminders with "Authorization: Bearer <CRON_SECRET>"; unset = that route is off.
  REMINDER_POLL_SECONDS: z.coerce.number().int().nonnegative().default(60),
  CRON_SECRET: z.string().min(16, 'Use at least 16 characters.').optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

module.exports = parsed.data;
