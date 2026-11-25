/** drizzle-kit: `npm run db:generate` writes SQL migrations from src/db/postgres/schema.js into ./drizzle. */
module.exports = {
  dialect: 'postgresql',
  schema: './src/db/postgres/schema.js',
  out: './drizzle',
};
