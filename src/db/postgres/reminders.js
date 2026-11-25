const { and, asc, count, desc, eq, isNull, lte, sql } = require('drizzle-orm');
const { db } = require('./connection');
const { reminders: R, users: U } = require('./schema');

const toReminder = (row) =>
  row && {
    id: row.id,
    title: row.title,
    note: row.note,
    startsAt: row.startsAt,
    remindAt: row.remindAt,
    repeat: row.repeat,
    timeZone: row.timeZone,
    active: row.active,
    lastSentAt: row.lastSentAt,
    createdAt: row.createdAt,
  };

const reminders = {
  /** The user's reminders: upcoming ones soonest first, then sent or paused ones, newest first. */
  async list(userId) {
    const rows = await db()
      .select()
      .from(R)
      .where(eq(R.userId, userId))
      .orderBy(desc(R.active), sql`case when ${R.active} then ${R.remindAt} end asc`, desc(R.remindAt));
    return rows.map(toReminder);
  },

  async countForUser(userId) {
    const [row] = await db().select({ n: count() }).from(R).where(eq(R.userId, userId));
    return row.n;
  },

  async find(userId, id) {
    const [row] = await db()
      .select()
      .from(R)
      .where(and(eq(R.id, id), eq(R.userId, userId)));
    return toReminder(row ?? null);
  },

  async create(userId, fields) {
    const [row] = await db()
      .insert(R)
      .values({ ...fields, userId })
      .returning();
    return toReminder(row);
  },

  async update(userId, id, changes) {
    const [row] = await db()
      .update(R)
      .set({ ...changes, updatedAt: new Date() })
      .where(and(eq(R.id, id), eq(R.userId, userId)))
      .returning();
    return toReminder(row ?? null);
  },

  async remove(userId, id) {
    const rows = await db()
      .delete(R)
      .where(and(eq(R.id, id), eq(R.userId, userId)))
      .returning({ id: R.id });
    return rows.length > 0;
  },

  /** Active reminders due by `now`, oldest first, with their owner's email and name (deleted accounts skipped). */
  async due(now, limit) {
    const rows = await db()
      .select({ reminder: R, email: U.email, name: U.name })
      .from(R)
      .innerJoin(U, eq(R.userId, U.id))
      .where(and(eq(R.active, true), lte(R.remindAt, now), isNull(U.deletedAt)))
      .orderBy(asc(R.remindAt))
      .limit(limit);
    return rows.map((r) => ({ ...toReminder(r.reminder), userId: r.reminder.userId, email: r.email, name: r.name }));
  },

  /**
   * Marks a due reminder as sent and moves it to `nextAt` (or deactivates it when null), only if no
   * other dispatcher run got there first. True when this run claimed it and should send the email.
   */
  async claim(id, dueAt, nextAt, now) {
    const rows = await db()
      .update(R)
      .set(nextAt ? { remindAt: nextAt, lastSentAt: now, updatedAt: now } : { active: false, lastSentAt: now, updatedAt: now })
      .where(and(eq(R.id, id), eq(R.active, true), eq(R.remindAt, dueAt)))
      .returning({ id: R.id });
    return rows.length > 0;
  },
};

/** Users who want the daily reading reminder and have a time zone to time it by. */
async function readingReminderCandidates() {
  return db()
    .select({
      id: U.id,
      email: U.email,
      name: U.name,
      timeZone: U.profileTimezone,
      reminderTime: U.reminderTime,
      sentOn: U.readingReminderSentOn,
    })
    .from(U)
    .where(
      and(eq(U.notifyReadingReminders, true), isNull(U.deletedAt), sql`${U.profileTimezone} is not null`),
    );
}

/** Records that today's reading reminder went out, unless another run already did. True when this run claimed it. */
async function claimReadingReminder(userId, localDate) {
  const rows = await db()
    .update(U)
    .set({ readingReminderSentOn: localDate })
    .where(and(eq(U.id, userId), sql`${U.readingReminderSentOn} is distinct from ${localDate}`))
    .returning({ id: U.id });
  return rows.length > 0;
}

module.exports = { reminders, readingReminderCandidates, claimReadingReminder };
