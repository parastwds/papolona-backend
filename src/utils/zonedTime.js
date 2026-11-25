/**
 * Wall-clock time in an IANA time zone (e.g. 'Asia/Kolkata'), using Node's built-in Intl data,
 * so repeating reminders keep their local time across daylight-saving changes.
 */

const formatters = new Map();
const formatterFor = (timeZone) => {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      }),
    );
  }
  return formatters.get(timeZone);
};

/** True when Intl knows the zone. */
function isTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The local calendar fields of an instant in a zone: { year, month (1–12), day, hour, minute, second }. */
function partsInZone(date, timeZone) {
  const parts = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** How far the zone is ahead of UTC at an instant, in milliseconds. */
function offsetAt(date, timeZone) {
  const p = partsInZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The instant when the zone's clocks show the given local time. Fields may overflow (day 32, month 13)
 * and are normalised like Date.UTC. A time skipped by a spring-forward lands just after the gap.
 */
function zonedToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(new Date(guess), timeZone);
  const second = guess - offsetAt(new Date(first), timeZone);
  return new Date(second);
}

/** 'YYYY-MM-DD' and 'HH:mm' for an instant in a zone. */
function localDateTime(date, timeZone) {
  const p = partsInZone(date, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The first time after `now` a repeating reminder is due again, counted from its first time
 * `startsAt` and keeping that local time of day: every day, every week, or every month on the
 * same day (the month's last day when it is shorter, without drifting in later months).
 */
function nextOccurrence(startsAt, repeat, timeZone, now = new Date()) {
  if (repeat === 'none') return null;
  const start = partsInZone(startsAt, timeZone);
  // Skip straight to just before `now` instead of walking every past occurrence.
  const elapsed = Math.max(0, now.getTime() - startsAt.getTime());
  const period = repeat === 'monthly' ? 31 * DAY_MS : repeat === 'weekly' ? 7 * DAY_MS : DAY_MS;
  const firstStep = Math.max(1, Math.floor(elapsed / period) - 1);
  for (let step = firstStep; step <= firstStep + 400; step += 1) {
    let fields;
    if (repeat === 'monthly') {
      const total = start.month - 1 + step;
      const year = start.year + Math.floor(total / 12);
      const month = (total % 12) + 1;
      fields = { year, month, day: Math.min(start.day, daysInMonth(year, month)) };
    } else {
      fields = { year: start.year, month: start.month, day: start.day + step * (repeat === 'weekly' ? 7 : 1) };
    }
    const next = zonedToUtc({ ...fields, hour: start.hour, minute: start.minute }, timeZone);
    if (next > now) return next;
  }
  return null;
}

module.exports = { isTimeZone, partsInZone, zonedToUtc, localDateTime, nextOccurrence };
