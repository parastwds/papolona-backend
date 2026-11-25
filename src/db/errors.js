/**
 * A unique constraint was hit (email, phone, journal clientId...). Every database driver throws this
 * instead of its own error (Postgres 23505), so services never depend on the driver.
 */
class DuplicateError extends Error {
  constructor(field = null) {
    super(field ? `Duplicate value for ${field}.` : 'Duplicate value.');
    this.name = 'DuplicateError';
    this.field = field;
  }
}

module.exports = { DuplicateError };
