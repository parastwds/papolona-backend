const path = require('path');
const schema = require('./schema');
const logger = require('../../utils/logger');

const MIGRATIONS = path.join(__dirname, '..', '..', '..', 'drizzle');

// Tests use an in-memory PGlite (real Postgres 18 compiled to WebAssembly) instead of a server;
// pglite://<folder> keeps a PGlite database in that folder, for local development without a server.
const IN_MEMORY_URL = 'pglite://memory';
const PGLITE_PREFIX = 'pglite://';

let state = null; // { db, close }
let connecting = null;

async function open(url) {
  if (url.startsWith(PGLITE_PREFIX)) {
    const { PGlite } = require('@electric-sql/pglite'); // dev dependency: tests and local development only
    const { drizzle } = require('drizzle-orm/pglite');
    const { migrate } = require('drizzle-orm/pglite/migrator');
    const client = url === IN_MEMORY_URL ? new PGlite() : new PGlite(path.resolve(url.slice(PGLITE_PREFIX.length)));
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS });
    return { db, close: () => client.close() };
  }

  const { Pool } = require('pg');
  const { drizzle } = require('drizzle-orm/node-postgres');
  // Small pool: on serverless every warm instance keeps its own, and Neon's pooler does the rest.
  // Neon suspends an idle database and the first connection waits for it to wake, so the connect
  // timeout is generous. Idle connections are closed early (Neon may drop them while it sleeps),
  // and keep-alive spots dead sockets instead of a query hanging on one.
  const pool = new Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 20000,
    idleTimeoutMillis: 10000,
    keepAlive: true,
  });
  // A connection that dies while idle in the pool must not crash the server; the next query opens a new one.
  pool.on('error', (err) => logger.error('PostgreSQL idle connection error', err.message));
  const db = drizzle(pool, { schema });
  await pool.query('select 1');
  return { db, close: () => pool.end() };
}

/** Connects once; later calls reuse the connection. A failed attempt is not cached, so the next call retries. */
function ensure(url) {
  if (state) return Promise.resolve();
  if (!connecting) {
    connecting = open(url)
      .then((s) => {
        state = s;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

async function close() {
  const s = state;
  state = null;
  if (s) await s.close();
}

/** The Drizzle database. Throws if used before connecting. */
function db() {
  if (!state) throw new Error('PostgreSQL is not connected.');
  return state.db;
}

const isConnected = () => !!state;

/** Applies the SQL migrations in ./drizzle to a real server (npm run db:migrate). */
async function migrateServer(url) {
  const { Pool } = require('pg');
  const { drizzle } = require('drizzle-orm/node-postgres');
  const { migrate } = require('drizzle-orm/node-postgres/migrator');
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
  } finally {
    await pool.end();
  }
}

module.exports = { ensure, close, db, isConnected, migrateServer, IN_MEMORY_URL };
