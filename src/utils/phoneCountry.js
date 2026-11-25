const { parsePhoneNumberFromString } = require('libphonenumber-js/min');

/**
 * The country a phone number belongs to, from its calling code: '+919876543210' -> 'IN'.
 * Shared calling codes are told apart by the digits that follow (+1 is US, CA, JM...; +7 is RU or KZ).
 * Returns an ISO 3166-1 alpha-2 code, or null when the number has no single country.
 */
function countryOfPhone(phone) {
  if (!phone) return null;
  const parsed = parsePhoneNumberFromString(phone);
  if (!parsed) return null;
  if (parsed.country) return parsed.country;
  // A number that isn't valid for any one country of a shared code: fall back to the code's main country.
  const [main] = parsed.getPossibleCountries();
  return main ?? null;
}

module.exports = { countryOfPhone };
