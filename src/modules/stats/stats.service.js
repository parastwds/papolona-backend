const db = require('../../db');
const ApiError = require('../../utils/ApiError');

/**
 * Activity stats for the Home screen: readings, pass/fail, notes and eeriness/satisfaction ratings
 * per day, month or year, in the user's local time.
 *
 * Local calendar dates are handled as 'YYYY-MM-DD' strings and, for arithmetic, as Date objects
 * at UTC midnight (so no device or server time zone leaks in); `offset` turns them into real instants.
 */

// Enough for a year of days (366) or 33 years of months.
const MAX_BUCKETS = 400;
const MINUTE = 60 * 1000;

const parseDay = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const formatDay = (date) => date.toISOString().slice(0, 10);

/** The start of the unit (day, month or year) that contains `date`. */
function unitStart(date, unit) {
  if (unit === 'year') return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  if (unit === 'month') return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** The start of the next unit after the one starting at `date`. */
function nextUnit(date, unit) {
  if (unit === 'year') return new Date(Date.UTC(date.getUTCFullYear() + 1, 0, 1));
  if (unit === 'month') return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return new Date(date.getTime() + 24 * 60 * MINUTE);
}

const localToday = (offset, now = new Date()) => formatDay(new Date(now.getTime() + offset * MINUTE));

const previousDay = (day) => formatDay(new Date(parseDay(day).getTime() - 24 * 60 * MINUTE));

/** Current and best runs of consecutive days with a reading; the current run survives until today ends. */
function streaks(days, today) {
  let best = 0;
  let run = 0;
  let prev = null;
  for (const day of days) {
    run = prev && previousDay(day) === prev ? run + 1 : 1;
    best = Math.max(best, run);
    prev = day;
  }
  const last = days[days.length - 1];
  const current = last === today || last === previousDay(today) ? run : 0;
  return { current, best };
}

const EMPTY_BUCKET = {
  readings: 0,
  passed: 0,
  failed: 0,
  notes: 0,
  userEeriness: null,
  userSatisfaction: null,
  aiEeriness: null,
  aiSatisfaction: null,
};

/**
 * Stats from the bucket containing `from` to the one containing `to` (local dates, inclusive).
 * Without `from`, they start at the user's first reading or note; without `to`, they end today.
 */
async function getStats(userId, { unit, from, to, tzOffset: offset = 0 }, now = new Date()) {
  const today = localToday(offset, now);
  const firstActivity = await db.stats.firstActivityDay(userId, offset);
  const endDay = to ?? today;
  const startDay = from ?? firstActivity ?? endDay;
  if (startDay > endDay) throw ApiError.badRequest('INVALID_RANGE', '`from` must not be after `to`.');

  const first = unitStart(parseDay(startDay), unit);
  const last = unitStart(parseDay(endDay), unit);
  const starts = [];
  for (let d = first; d <= last; d = nextUnit(d, unit)) {
    starts.push(d);
    if (starts.length > MAX_BUCKETS) {
      throw ApiError.badRequest('RANGE_TOO_LARGE', `Ask for at most ${MAX_BUCKETS} ${unit}s; use a larger unit.`);
    }
  }

  // The range as real instants: local midnight at its start, to local midnight after its last bucket.
  const range = {
    from: new Date(first.getTime() - offset * MINUTE).toISOString(),
    to: new Date(nextUnit(last, unit).getTime() - offset * MINUTE).toISOString(),
  };
  const [byStart, totals, readingDays] = await Promise.all([
    db.stats.buckets(userId, { unit, offset, ...range }),
    db.stats.totals(userId, range),
    db.stats.readingDays(userId, offset),
  ]);

  return {
    unit,
    from: formatDay(first),
    to: formatDay(last),
    today,
    firstActivity,
    series: starts.map((d) => {
      const start = formatDay(d);
      return { start, ...EMPTY_BUCKET, ...byStart.get(start) };
    }),
    totals,
    streak: streaks(readingDays, today),
  };
}

module.exports = { getStats, streaks, MAX_BUCKETS };
