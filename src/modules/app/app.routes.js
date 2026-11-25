const { Router } = require('express');
const db = require('../../db');

const router = Router();

/** GET /health — liveness + DB check for load balancers / uptime monitors. */
router.get('/health', async (_req, res) => {
  const dbUp = await db.ping();
  res.status(dbUp ? 200 : 503).json({ success: dbUp, data: { status: dbUp ? 'ok' : 'degraded', db: dbUp, driver: db.driver } });
});

/**
 * GET /app/config — called by the Splash screen.
 * The app compares its version with minSupportedVersion to force an update,
 * and shows the maintenance message if enabled.
 */
router.get('/app/config', async (_req, res) => {
  const config = await db.appConfig.get();
  const legal = { termsVersion: config.legal.termsVersion, privacyVersion: config.legal.privacyVersion };

  res.json({
    success: true,
    data: {
      minSupportedVersion: config.minSupportedVersion,
      latestVersion: config.latestVersion,
      storeUrls: config.storeUrls,
      maintenance: config.maintenance,
      supportEmail: config.supportEmail,
      legal,
      serverTime: new Date().toISOString(),
    },
  });
});

module.exports = router;
