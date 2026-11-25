const env = require('./config/env');
const db = require('./db');
const { createApp } = require('./app');
const logger = require('./utils/logger');
const { verifyMailer } = require('./utils/mailer');
const { dispatchDue } = require('./modules/reminders/reminders.service');

/** Emails due reminders every REMINDER_POLL_SECONDS; a run is skipped while the previous one is still going. */
function startReminderPolling() {
  if (!env.REMINDER_POLL_SECONDS) return null;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await dispatchDue();
    } catch (err) {
      logger.error('Reminder dispatch failed', err.message);
    } finally {
      running = false;
    }
  }, env.REMINDER_POLL_SECONDS * 1000);
  timer.unref();
  logger.info(`Reminder emails: checking every ${env.REMINDER_POLL_SECONDS}s`);
  return timer;
}

async function start() {
  await db.connect(env.DATABASE_URL);
  verifyMailer();
  const reminderTimer = startReminderPolling();
  const server = createApp().listen(env.PORT, () => {
    logger.info(`Papolona API listening on http://localhost:${env.PORT}/api/v1 (${env.NODE_ENV})`);
  });

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    if (reminderTimer) clearInterval(reminderTimer);
    server.close(async () => {
      await db.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error('Failed to start server', err);
  process.exit(1);
});  
