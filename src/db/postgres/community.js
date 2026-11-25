const { sql } = require('drizzle-orm');
const { db } = require('./connection');

const community = {
  /**
   * The Discover screen's figures for the whole collective: readings drawn (perception sessions),
   * series completed (each one an artwork), countries users come from (by mobile number), and
   * members. Suspended and deleted accounts are not counted as people or countries.
   */
  async stats() {
    const result = await db().execute(sql`
      select
        (select count(*)::int from clue_draws) as sessions,
        (select count(*)::int from nft_series where status = 'completed') as artworks,
        (select count(distinct phone_country)::int from users
          where status in ('probation', 'member') and phone_country is not null) as countries,
        (select count(*)::int from users where status = 'member') as members`);
    const [row] = result.rows ?? result;
    return row;
  },
};

module.exports = { community };
