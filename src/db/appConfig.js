/**
 * The app config both drivers store (one record, key "app"), with the values used for anything not saved yet.
 *
 * `legal` holds the current Terms and Privacy Policy versions. The text itself is in the app; bump a version here
 * when that text changes, and every user who accepted an older one is asked to accept again (GET /users/me).
 */
const DEFAULT_APP_CONFIG = {
  minSupportedVersion: { ios: '1.0.0', android: '1.0.0' },
  latestVersion: { ios: '1.0.0', android: '1.0.0' },
  storeUrls: { ios: '', android: '' },
  maintenance: { enabled: false, message: 'Papolona is being updated. Please try again shortly.' },
  supportEmail: 'support@papolona.com',
  legal: { termsVersion: '1.0', privacyVersion: '1.0' },
};

const NESTED = ['minSupportedVersion', 'latestVersion', 'storeUrls', 'maintenance', 'legal'];

/** A stored config (possibly partial, possibly missing) filled in with the defaults. */
function withDefaults(stored = {}) {
  const config = { supportEmail: stored?.supportEmail ?? DEFAULT_APP_CONFIG.supportEmail };
  for (const key of NESTED) {
    const saved = Object.fromEntries(Object.entries(stored?.[key] ?? {}).filter(([, v]) => v !== undefined && v !== null));
    config[key] = { ...DEFAULT_APP_CONFIG[key], ...saved };
  }
  return config;
}

module.exports = { DEFAULT_APP_CONFIG, withDefaults };
