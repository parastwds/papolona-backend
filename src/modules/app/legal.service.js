const db = require('../../db');

/** The Terms and Privacy versions users must have accepted (from the app config; the text is in the app). */
async function getCurrentLegalVersions() {
  const { legal } = await db.appConfig.get();
  return { termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion };
}

module.exports = { getCurrentLegalVersions };
