const db = require('../../db');
const ApiError = require('../../utils/ApiError');
const env = require('../../config/env');
const pennies = require('../pennies/pennies.service');
const { publicName } = require('../artwork/artwork.service');

/**
 * Direct messages between members. A conversation starts as a message request: the sender writes a first
 * message and the other person accepts or declines it. Once accepted, both can write. Either can block the
 * other: then neither can send, and they no longer find each other in search. A declined request stays
 * "sent" for its sender (they are not told), and the person who declined can still start a request later.
 */

const MIN_QUERY = 2;
const PAGE = 50;

const publicUser = (u) => ({ id: u.id, name: publicName(u.name), avatarUrl: u.avatarUrl ?? null });

/**
 * Where a thread stands for `me`: 'connected' (accepted), 'incoming' (a request to me), 'requested' (my
 * request, waiting; a declined one looks the same to its sender), or 'declined' (a request I declined).
 */
function stateOf(thread, me) {
  if (thread.status === 'accepted') return 'connected';
  const mine = thread.requestedBy === me;
  if (thread.status === 'pending') return mine ? 'requested' : 'incoming';
  return mine ? 'requested' : 'declined';
}

/** A thread from listThreadsFor, for the app. */
function toPublicThread(t, me) {
  const state = stateOf(t, me);
  const blocked = t.blockedByMe ? 'by_me' : t.blockedMe ? 'by_them' : null;
  return {
    id: t.id,
    state,
    other: publicUser(t.other),
    lastMessage: t.lastMessage
      ? { text: t.lastMessage.text, createdAt: t.lastMessage.createdAt, mine: t.lastMessage.senderId === me }
      : null,
    lastActivityAt: t.lastMessageAt ?? t.createdAt,
    unread: state === 'connected' || state === 'incoming' ? t.unread : 0,
    blocked,
    canSend: state === 'connected' && !blocked,
  };
}

const toPublicMessage = (m, me) => ({ id: m.id, text: m.text, createdAt: m.createdAt, mine: m.senderId === me });

/** The user's thread `id` with everything the app shows, or a 404. A request they declined is hidden. */
async function ownThread(user, id) {
  const all = await db.dms.listThreadsFor(user.id);
  const t = all.find((x) => x.id === id);
  if (!t || stateOf(t, user.id) === 'declined') {
    throw ApiError.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found.');
  }
  return t;
}

/**
 * The Messages tab: { conversations (accepted), requests (sent to me, waiting), sent (my requests, waiting),
 * unreadCount }. Requests from people I blocked are left out; unreadCount counts unread messages in
 * conversations plus waiting requests.
 */
async function list(user) {
  const threads = (await db.dms.listThreadsFor(user.id)).map((t) => toPublicThread(t, user.id));
  const conversations = threads.filter((t) => t.state === 'connected');
  const requests = threads.filter((t) => t.state === 'incoming' && t.blocked !== 'by_me');
  const sent = threads.filter((t) => t.state === 'requested');
  const unreadCount =
    conversations.reduce((n, t) => n + (t.blocked ? 0 : t.unread), 0) + requests.length;
  return { conversations, requests, sent, unreadCount };
}

/**
 * Members whose name contains `q`, to message: { users: [{ id, name, avatarUrl, state, threadId }] } where
 * state is 'none', 'requested', 'incoming' or 'connected'. Not the user, nobody either side has blocked.
 */
async function search(user, q) {
  const query = q.trim();
  if (query.length < MIN_QUERY) return { users: [] };
  const [found, threads] = await Promise.all([db.dms.searchUsers(user.id, query), db.dms.listThreadsFor(user.id)]);
  const byOther = new Map(threads.map((t) => [t.other.id, t]));
  return {
    users: found.map((u) => {
      const t = byOther.get(u.id);
      const state = t ? stateOf(t, user.id) : 'none';
      return { ...publicUser(u), state: state === 'declined' ? 'none' : state, threadId: t && state !== 'declined' ? t.id : null };
    }),
  };
}

/** Refuses when either side has blocked the other. */
async function assertNotBlocked(meId, otherId) {
  const { byX: byMe, byY: byThem } = await db.dms.blocksBetween(meId, otherId);
  if (byMe) throw ApiError.conflict('YOU_BLOCKED', 'You have blocked this member. Unblock them to message.');
  if (byThem) throw ApiError.forbidden('CANNOT_MESSAGE', 'You can’t message this member.');
}

/**
 * Sends a message request to `userId` with a first message. Resolves to { thread }. Refused for oneself,
 * when blocked, when already connected (ALREADY_CONNECTED), when a request is waiting either way
 * (REQUEST_PENDING / REQUEST_INCOMING, with the thread id).
 */
async function request(user, { userId, text }) {
  if (userId === user.id) throw ApiError.badRequest('CANNOT_MESSAGE_SELF', 'You can’t message yourself.');
  const other = await db.dms.findReachableUser(userId);
  if (!other) throw ApiError.notFound('USER_NOT_FOUND', 'Member not found.');
  await assertNotBlocked(user.id, userId);

  const existing = await db.dms.findThreadBetween(user.id, userId);
  if (existing) {
    const state = stateOf(existing, user.id);
    const details = { threadId: existing.id };
    if (state === 'connected') throw new ApiError(409, 'ALREADY_CONNECTED', 'You are already talking.', details);
    if (state === 'requested') throw new ApiError(409, 'REQUEST_PENDING', 'Your request is waiting for a reply.', details);
    if (state === 'incoming') {
      throw new ApiError(409, 'REQUEST_INCOMING', 'They have sent you a request: accept it to talk.', details);
    }
  }
  // A message request costs a few pennies (the messages after it are free).
  const created = await pennies.chargeFor(user.id, env.PENNY_MESSAGE_REQUEST_PRICE, 'message_request', async () => {
    const made = await db.dms.createRequest(user.id, userId, text);
    // Another request between the two arrived first: given back.
    if (!made) throw ApiError.conflict('REQUEST_PENDING', 'A request between you is already waiting.');
    return made;
  });
  return { thread: toPublicThread(await ownThread(user, created.thread.id), user.id) };
}

/** Accepts or declines a request sent to the user. Resolves to { thread } (null once declined). */
async function answer(user, id, accept) {
  const updated = await db.dms.answerRequest(user.id, id, accept ? 'accepted' : 'declined');
  if (!updated) throw ApiError.notFound('REQUEST_NOT_FOUND', 'Request not found.');
  return { thread: accept ? toPublicThread(await ownThread(user, id), user.id) : null };
}

/**
 * One conversation: { thread, messages (newest first), nextBefore }. Opening it marks it read.
 */
async function get(user, id, { before = null } = {}) {
  const t = await ownThread(user, id);
  const messages = await db.dms.listMessages(id, { before, limit: PAGE });
  if (!before) await db.dms.markRead(t, user.id);
  return {
    thread: toPublicThread({ ...t, unread: 0 }, user.id),
    messages: messages.map((m) => toPublicMessage(m, user.id)),
    nextBefore: messages.length === PAGE ? messages[messages.length - 1].id : null,
  };
}

/** Sends a message in an accepted conversation. Resolves to { message }. */
async function send(user, id, { text }) {
  const t = await ownThread(user, id);
  const state = stateOf(t, user.id);
  if (state === 'requested') {
    throw ApiError.conflict('REQUEST_PENDING', 'You can write more once they accept your request.');
  }
  if (state === 'incoming') throw ApiError.conflict('REQUEST_INCOMING', 'Accept the request to reply.');
  await assertNotBlocked(user.id, t.other.id);
  const message = await db.dms.addMessage(t, user.id, text);
  return { message: toPublicMessage(message, user.id) };
}

/** Blocks a member; a request they sent the user is declined. Resolves to { blocked: true }. */
async function block(user, userId) {
  if (userId === user.id) throw ApiError.badRequest('CANNOT_BLOCK_SELF', 'You can’t block yourself.');
  const other = await db.users.findById(userId);
  if (!other) throw ApiError.notFound('USER_NOT_FOUND', 'Member not found.');
  await db.dms.block(user.id, userId);
  const thread = await db.dms.findThreadBetween(user.id, userId);
  if (thread && thread.status === 'pending' && thread.requestedBy === userId) {
    await db.dms.answerRequest(user.id, thread.id, 'declined');
  }
  return { blocked: true };
}

async function unblock(user, userId) {
  await db.dms.unblock(user.id, userId);
  return { blocked: false };
}

/** The members the user has blocked: { users: [{ id, name, avatarUrl, blockedAt }] }. */
async function blocked(user) {
  const rows = await db.dms.listBlocked(user.id);
  return { users: rows.map((r) => ({ ...publicUser(r), blockedAt: r.blockedAt })) };
}

module.exports = { list, search, request, answer, get, send, block, unblock, blocked, MIN_QUERY };
