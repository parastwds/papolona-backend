/** Client metadata stored with sessions and legal acceptances (audit trail). */
function clientMeta(req) {
  return {
    ip: req.ip,
    userAgent: (req.get('user-agent') || '').slice(0, 300),
    platform: req.get('x-platform') || undefined, // app sends "ios" | "android"
    appVersion: req.get('x-app-version') || undefined,
  };
}

module.exports = { clientMeta };
