const db = require('../db');
const data = require('./data');

/**
 * Idempotent: safe to run repeatedly. Inserts the questionnaire version if it
 * does not exist and makes it active; existing versions are NOT overwritten
 * (submissions depend on them) — add a new version instead. The app config is
 * created once; later changes (e.g. new legal versions) are made on the record.
 */
async function seed() {
  if (!(await db.questionnaires.versionExists(data.questionnaire.version))) {
    await db.questionnaires.publish(data.questionnaire);
  }

  if (!(await db.appConfig.exists())) await db.appConfig.create(data.appConfig);
}

module.exports = { seed };

if (require.main === module) {
  const env = require('../config/env');
  const logger = require('../utils/logger');
  db.connect(env.DATABASE_URL)
    .then(seed)
    .then(() => logger.info(`Seed complete (${db.driver})`))
    .then(() => db.disconnect())
    .catch((err) => {
      logger.error('Seed failed', err);
      process.exit(1);
    });
}
