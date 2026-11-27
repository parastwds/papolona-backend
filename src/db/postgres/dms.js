const { and, asc, desc, eq, lt, or, sql } = require('drizzle-orm');
const { db } = require('./connection');
const { dmMessages: M, dmThreads: T, userBlocks: B, users: U } = require('./schema');

const rowsOf = (result) => result.rows ?? result;

// Raw SQL returns timestamps as Postgres text ("2026-11-27 10:46:20.731+00"): as Dates, so they reach the
// app as ISO strings that every platform parses.
const toDate = (value) => {
  if (value == null) return null;
  if (value instanceof Date) return value;
  return new Date(String(value).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
};
const isDuplicate = (err) => err?.code === '23505' || err?.cause?.code === '23505';

/** The pair in thread order: user_a is the smaller id. */
const pairOf = (x, y) => (x < y ? [x, y] : [y, x]);

/** A thread as the service uses it, from a dm_threads row. */
const toThread = (row) =>
  row && {
    id: row.id,
    userA: row.userA,
    userB: row.userB,
    requestedBy: row.requestedBy,
    status: row.status,
    acceptedAt: row.acceptedAt ?? null,
    lastMessageAt: row.lastMessageAt ?? null,
    userAReadAt: row.userAReadAt ?? null,
    userBReadAt: row.userBReadAt ?? null,
    createdAt: row.createdAt,
  };

const toMessage = (row) =>
  row && { id: row.id, threadId: row.threadId, senderId: row.senderId, text: row.text, createdAt: row.createdAt };

// Users who can be found and messaged: not suspended or deleted.
const REACHABLE = sql`${U.status} in ('probation', 'member')`;

const dms = {
  /**
   * Users whose name contains `query` (any case), for the viewer to message: not the viewer, not anyone
   * either of them has blocked, reachable only. Alphabetical. [{ id, name, avatarUrl }].
   */
  async searchUsers(viewerId, query, limit = 20) {
    const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await db()
      .select({ id: U.id, name: U.name, avatarUrl: U.profileAvatarUrl })
      .from(U)
      .where(
        and(
          REACHABLE,
          sql`${U.id} <> ${viewerId}`,
          sql`${U.name} ilike ${pattern}`,
          sql`not exists (select 1 from user_blocks b where (b.blocker_id = ${viewerId} and b.blocked_id = ${U.id})
            or (b.blocker_id = ${U.id} and b.blocked_id = ${viewerId}))`,
        ),
      )
      .orderBy(asc(U.name))
      .limit(limit);
    return rows;
  },

  /** One reachable user to message, or null: { id, name, avatarUrl }. */
  async findReachableUser(id) {
    const [row] = await db()
      .select({ id: U.id, name: U.name, avatarUrl: U.profileAvatarUrl })
      .from(U)
      .where(and(eq(U.id, id), REACHABLE));
    return row ?? null;
  },

  /** Who has blocked whom between x and y: { byX, byY }. */
  async blocksBetween(x, y) {
    const rows = await db()
      .select({ blockerId: B.blockerId })
      .from(B)
      .where(or(and(eq(B.blockerId, x), eq(B.blockedId, y)), and(eq(B.blockerId, y), eq(B.blockedId, x))));
    return { byX: rows.some((r) => r.blockerId === x), byY: rows.some((r) => r.blockerId === y) };
  },

  /** Blocks `blockedId` for `blockerId` (no-op if already blocked). */
  async block(blockerId, blockedId) {
    await db().insert(B).values({ blockerId, blockedId }).onConflictDoNothing();
  },

  async unblock(blockerId, blockedId) {
    await db().delete(B).where(and(eq(B.blockerId, blockerId), eq(B.blockedId, blockedId)));
  },

  /** The users `blockerId` has blocked, newest first: [{ id, name, avatarUrl, blockedAt }]. */
  async listBlocked(blockerId) {
    return db()
      .select({ id: U.id, name: U.name, avatarUrl: U.profileAvatarUrl, blockedAt: B.createdAt })
      .from(B)
      .innerJoin(U, eq(U.id, B.blockedId))
      .where(eq(B.blockerId, blockerId))
      .orderBy(desc(B.createdAt));
  },

  async findThread(id) {
    const [row] = await db().select().from(T).where(eq(T.id, id));
    return toThread(row ?? null);
  },

  async findThreadBetween(x, y) {
    const [a, b] = pairOf(x, y);
    const [row] = await db().select().from(T).where(and(eq(T.userA, a), eq(T.userB, b)));
    return toThread(row ?? null);
  },

  /**
   * Opens a message request from `fromId` to `toId` with its first message, in one transaction. A thread the
   * other side declined (or requested and was declined) is reopened as a new request from `fromId`.
   * Resolves to { thread, message }, or null when another request created the thread first.
   */
  async createRequest(fromId, toId, text, now = new Date()) {
    const [a, b] = pairOf(fromId, toId);
    try {
      return await db().transaction(async (tx) => {
        const [existing] = await tx.select().from(T).where(and(eq(T.userA, a), eq(T.userB, b))).for('update');
        const fromIsA = fromId === a;
        const reads = fromIsA ? { userAReadAt: now, userBReadAt: null } : { userBReadAt: now, userAReadAt: null };
        let thread;
        if (existing) {
          if (existing.status !== 'declined') return null;
          [thread] = await tx
            .update(T)
            .set({ requestedBy: fromId, status: 'pending', acceptedAt: null, lastMessageAt: now, updatedAt: now, ...reads })
            .where(eq(T.id, existing.id))
            .returning();
        } else {
          [thread] = await tx
            .insert(T)
            .values({ userA: a, userB: b, requestedBy: fromId, status: 'pending', lastMessageAt: now, ...reads })
            .returning();
        }
        const [message] = await tx
          .insert(M)
          .values({ threadId: thread.id, senderId: fromId, text, createdAt: now })
          .returning();
        return { thread: toThread(thread), message: toMessage(message) };
      });
    } catch (err) {
      if (isDuplicate(err)) return null;
      throw err;
    }
  },

  /** Accepts or declines a pending request sent to `userId`. Resolves to the thread, or null if not theirs to answer. */
  async answerRequest(userId, threadId, status, now = new Date()) {
    const [row] = await db()
      .update(T)
      .set({ status, acceptedAt: status === 'accepted' ? now : null, updatedAt: now })
      .where(
        and(
          eq(T.id, threadId),
          eq(T.status, 'pending'),
          sql`${T.requestedBy} <> ${userId}`,
          or(eq(T.userA, userId), eq(T.userB, userId)),
        ),
      )
      .returning();
    return toThread(row ?? null);
  },

  /** Adds a message to an accepted thread and moves its last-message time on; the sender has read up to it. */
  async addMessage(thread, senderId, text, now = new Date()) {
    return db().transaction(async (tx) => {
      const [message] = await tx.insert(M).values({ threadId: thread.id, senderId, text, createdAt: now }).returning();
      const read = senderId === thread.userA ? { userAReadAt: now } : { userBReadAt: now };
      await tx
        .update(T)
        .set({ lastMessageAt: now, updatedAt: now, ...read })
        .where(eq(T.id, thread.id));
      return toMessage(message);
    });
  },

  /** A page of a thread's messages, newest first, older than `before` (a message id) if given. */
  async listMessages(threadId, { before = null, limit = 50 } = {}) {
    const rows = await db()
      .select()
      .from(M)
      .where(and(eq(M.threadId, threadId), before ? lt(M.id, before) : undefined))
      .orderBy(desc(M.id))
      .limit(limit);
    return rows.map(toMessage);
  },

  /** Marks the thread read up to `at` for `userId`. */
  async markRead(thread, userId, at = new Date()) {
    const read = userId === thread.userA ? { userAReadAt: at } : { userBReadAt: at };
    await db().update(T).set(read).where(eq(T.id, thread.id));
  },

  /**
   * Every thread `userId` is in, newest activity first, each with the other user, the last message and how
   * many messages from the other side are unread, and who has blocked whom.
   */
  async listThreadsFor(userId) {
    const result = await db().execute(sql`
      select t.id, t.user_a, t.user_b, t.requested_by, t.status, t.accepted_at, t.last_message_at, t.created_at,
        o.id as other_id, o.name as other_name, o.profile_avatar_url as other_avatar,
        lm.text as last_text, lm.sender_id as last_sender, lm.created_at as last_at,
        (select count(*)::int from dm_messages m
          where m.thread_id = t.id and m.sender_id <> ${userId}
            and m.created_at > coalesce(case when t.user_a = ${userId} then t.user_a_read_at else t.user_b_read_at end,
              'epoch'::timestamptz)) as unread,
        exists (select 1 from user_blocks b where b.blocker_id = ${userId} and b.blocked_id = o.id) as blocked_by_me,
        exists (select 1 from user_blocks b where b.blocker_id = o.id and b.blocked_id = ${userId}) as blocked_me
      from dm_threads t
      join users o on o.id = case when t.user_a = ${userId} then t.user_b else t.user_a end
      left join lateral (
        select text, sender_id, created_at from dm_messages m where m.thread_id = t.id order by m.id desc limit 1
      ) lm on true
      where (t.user_a = ${userId} or t.user_b = ${userId}) and o.status in ('probation', 'member')
      order by coalesce(t.last_message_at, t.created_at) desc
      limit 200
    `);
    return rowsOf(result).map((r) => ({
      id: r.id,
      userA: r.user_a,
      userB: r.user_b,
      requestedBy: r.requested_by,
      status: r.status,
      acceptedAt: toDate(r.accepted_at),
      lastMessageAt: toDate(r.last_message_at),
      createdAt: toDate(r.created_at),
      other: { id: r.other_id, name: r.other_name, avatarUrl: r.other_avatar },
      lastMessage: r.last_at ? { text: r.last_text, senderId: r.last_sender, createdAt: toDate(r.last_at) } : null,
      unread: Number(r.unread ?? 0),
      blockedByMe: Boolean(r.blocked_by_me),
      blockedMe: Boolean(r.blocked_me),
    }));
  },
};

module.exports = { dms, pairOf };
