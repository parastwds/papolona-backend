const { DuplicateError } = require('../errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isValidId = (id) => typeof id === 'string' && UUID.test(id);

// Drizzle wraps driver errors; the Postgres error (with its SQLSTATE code) is then the cause.
const pgError = (err) => (err?.code ? err : err?.cause?.code ? err.cause : null);

const UNIQUE_VIOLATION = '23505';
const INVALID_TEXT = '22P02'; // e.g. a malformed uuid

/** Runs a write and turns Postgres's unique violation into the shared DuplicateError. */
async function translateDuplicate(write) {
  try {
    return await write();
  } catch (err) {
    const pg = pgError(err);
    if (pg?.code === UNIQUE_VIOLATION) throw new DuplicateError(pg.constraint ?? null);
    throw err;
  }
}

const isInvalidIdError = (err) => pgError(err)?.code === INVALID_TEXT;

/** Copies the defined values of `changes` into columns, using `map` ({ field: column }) to rename. */
function pickColumns(changes, map) {
  const out = {};
  for (const [field, column] of Object.entries(map)) {
    if (changes?.[field] !== undefined) out[column] = changes[field];
  }
  return out;
}

module.exports = { isValidId, translateDuplicate, isInvalidIdError, pickColumns };
