/**
 * `npm run db:migrate`: applies the SQL migrations in ./drizzle to the PostgreSQL database in DATABASE_URL.
 * Safe to re-run: applied migrations are recorded and skipped.
 */
const env = require('../src/config/env');
const logger = require('../src/utils/logger');

const db = require('../src/db');

/** Data that SQL alone cannot derive. Only touches rows still missing the value. */
async function backfill() {
  await db.connect(env.DATABASE_URL);
  try {
    const filled = await db.users.backfillPhoneCountries();
    if (filled) logger.info(`Phone countries filled for ${filled} user(s)`);
  } finally {
    await db.disconnect();
  }
}

db.migrate(env.DATABASE_URL)
  .then(() => logger.info(`Migrations applied to ${new URL(env.DATABASE_URL).hostname}`))
  .then(backfill)
  .catch((err) => {
    logger.error('Migration failed', err);
    process.exit(1);
  });
