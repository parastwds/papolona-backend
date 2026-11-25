/**
 * Vercel entry point. vercel.json sends every path here; the Express app routes it as usual.
 * Local development and always-on hosts keep using src/server.js.
 */
const env = require('../src/config/env');
const db = require('../src/db');
const { createApp } = require('../src/app');
const logger = require('../src/utils/logger');

const app = createApp();

module.exports = async (req, res) => {
  try {
    await db.ensureConnected(env.DATABASE_URL);
  } catch (err) {
    logger.error(`Database connection failed (${db.driver})`, err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable. Please try again.' } }));
    return;
  }
  return app(req, res);
};
