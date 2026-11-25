const { sql } = require('drizzle-orm');
const { db } = require('./connection');

/**
 * Activity stats for the Home screen graphs, counted in the user's local time.
 * `offset` is the user's UTC offset in minutes (e.g. 330 for India); days, months and years are cut
 * at local midnight with that offset.
 */

const UNITS = new Set(['day', 'month', 'year']);

// A timestamp column shifted into the user's local time, cut to the start of its unit, as 'YYYY-MM-DD'.
const bucketOf = (column, unit, offset) =>
  sql`to_char(date_trunc(${sql.raw(`'${unit}'`)}, ${column} + make_interval(mins => ${offset})), 'YYYY-MM-DD')`;

const localDayOf = (column, offset) =>
  sql`to_char(${column} + make_interval(mins => ${offset}), 'YYYY-MM-DD')`;

const round1 = (value) => (value == null ? null : Math.round(Number(value) * 10) / 10);

const readingAggregates = sql`
  count(*)::int as readings,
  count(*) filter (where verdict = 'pass')::int as passed,
  count(*) filter (where verdict = 'fail')::int as failed,
  avg(user_eeriness) as user_eeriness,
  avg(user_satisfaction) as user_satisfaction,
  avg(ai_eeriness) as ai_eeriness,
  avg(ai_satisfaction) as ai_satisfaction`;

const toRatings = (row) => ({
  userEeriness: round1(row?.user_eeriness),
  userSatisfaction: round1(row?.user_satisfaction),
  aiEeriness: round1(row?.ai_eeriness),
  aiSatisfaction: round1(row?.ai_satisfaction),
});

const rowsOf = (result) => result.rows ?? result;

const stats = {
  /**
   * Readings (with pass/fail and average ratings) and notes per unit bucket in [from, to) (UTC instants),
   * keyed by the bucket's local start date. Buckets with no activity are absent.
   */
  async buckets(userId, { unit, offset, from, to }) {
    if (!UNITS.has(unit)) throw new Error(`Unknown unit: ${unit}`);
    const bucket = (column) => bucketOf(column, unit, offset);
    const readings = rowsOf(
      await db().execute(sql`
        select ${bucket(sql`generated_at`)} as start, ${readingAggregates}
        from clue_draws
        where user_id = ${userId} and generated_at >= ${from}::timestamptz and generated_at < ${to}::timestamptz
        group by 1`),
    );
    const notes = rowsOf(
      await db().execute(sql`
        select ${bucket(sql`created_at`)} as start, count(*)::int as notes
        from journal_entries
        where user_id = ${userId} and created_at >= ${from}::timestamptz and created_at < ${to}::timestamptz
        group by 1`),
    );
    const byStart = new Map();
    for (const row of readings) {
      byStart.set(row.start, { readings: row.readings, passed: row.passed, failed: row.failed, notes: 0, ...toRatings(row) });
    }
    for (const row of notes) {
      const existing = byStart.get(row.start);
      if (existing) existing.notes = row.notes;
      else byStart.set(row.start, { readings: 0, passed: 0, failed: 0, notes: row.notes, ...toRatings(null) });
    }
    return byStart;
  },

  /** Totals across [from, to): readings, pass/fail, notes and average ratings (weighted by reading). */
  async totals(userId, { from, to }) {
    const [reading] = rowsOf(
      await db().execute(sql`
        select ${readingAggregates}
        from clue_draws
        where user_id = ${userId} and generated_at >= ${from}::timestamptz and generated_at < ${to}::timestamptz`),
    );
    const [note] = rowsOf(
      await db().execute(sql`
        select count(*)::int as notes
        from journal_entries
        where user_id = ${userId} and created_at >= ${from}::timestamptz and created_at < ${to}::timestamptz`),
    );
    return {
      readings: reading?.readings ?? 0,
      passed: reading?.passed ?? 0,
      failed: reading?.failed ?? 0,
      notes: note?.notes ?? 0,
      ...toRatings(reading),
    };
  },

  /** Every local day (YYYY-MM-DD) the user drew a clue, oldest first: for streaks. */
  async readingDays(userId, offset) {
    const rows = rowsOf(
      await db().execute(sql`
        select distinct ${localDayOf(sql`generated_at`, offset)} as day
        from clue_draws
        where user_id = ${userId}
        order by 1`),
    );
    return rows.map((r) => r.day);
  },

  /** The local day of the user's first reading or note, or null when they have neither. */
  async firstActivityDay(userId, offset) {
    const [row] = rowsOf(
      await db().execute(sql`
        select to_char(min(at) + make_interval(mins => ${offset}), 'YYYY-MM-DD') as day
        from (
          select min(generated_at) as at from clue_draws where user_id = ${userId}
          union all
          select min(created_at) from journal_entries where user_id = ${userId}
        ) firsts`),
    );
    return row?.day ?? null;
  },
};

module.exports = { stats };
