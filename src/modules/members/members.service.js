const db = require('../../db');
const ApiError = require('../../utils/ApiError');
const { publicName } = require('../artwork/artwork.service');
const series = require('../series/series.service');

/**
 * Member profiles, opened from search in Discover. Anyone signed in sees a member's name, photo, bio,
 * country, membership and how many readings and NFTs they have. The readings and NFTs themselves stay
 * locked until the member approves the viewer's request to see them. A member never sees the profile of
 * someone who has blocked them.
 */

const MEMBERSHIP_TITLES = { explorer: 'Explorer', creator: 'Creator', collector: 'Collector' };

const publicUser = (u) => ({ id: u.id, name: publicName(u.name), avatarUrl: u.avatarUrl ?? null });

/** "Creator", "Member" or "Apprentice". */
const roleOf = (user) =>
  user.status === 'member' ? MEMBERSHIP_TITLES[user.membershipType] ?? 'Member' : 'Apprentice';

/** Where the viewer stands: 'self', 'approved', 'pending', 'denied' or 'none'. */
async function accessOf(owner, viewer) {
  if (owner.id === viewer.id) return 'self';
  const access = await db.members.findAccess(owner.id, viewer.id);
  return access?.status ?? 'none';
}

/** A reachable member, or a 404 (also when they have blocked the viewer). */
async function reachableMember(viewer, id) {
  const user = await db.users.findById(id);
  if (!user || !['probation', 'member'].includes(user.status)) {
    throw ApiError.notFound('MEMBER_NOT_FOUND', 'Member not found.');
  }
  if (id !== viewer.id) {
    const { byY: blockedMe } = await db.dms.blocksBetween(viewer.id, id);
    if (blockedMe) throw ApiError.notFound('MEMBER_NOT_FOUND', 'Member not found.');
  }
  return user;
}

/**
 * A member's profile: { member, stats, access, dm, blocked, readings?, nfts? }. readings and nfts are there
 * only for the member themself and viewers they approved.
 */
async function profile(viewer, id) {
  const user = await reachableMember(viewer, id);
  const [stats, access, thread, blocks] = await Promise.all([
    db.members.stats(id),
    accessOf(user, viewer),
    id === viewer.id ? null : db.dms.findThreadBetween(viewer.id, id),
    id === viewer.id ? { byX: false } : db.dms.blocksBetween(viewer.id, id),
  ]);
  const open = access === 'self' || access === 'approved';
  let dm = { state: 'none', threadId: null };
  if (thread) {
    const mine = thread.requestedBy === viewer.id;
    const state =
      thread.status === 'accepted' ? 'connected' : thread.status === 'pending' && !mine ? 'incoming' : mine ? 'requested' : 'none';
    dm = { state, threadId: state === 'none' ? null : thread.id };
  }
  const result = {
    member: {
      ...publicUser({ id: user.id, name: user.name, avatarUrl: user.profile.avatarUrl }),
      bio: user.profile.bio ?? '',
      country: user.profile.country ?? null,
      role: roleOf(user),
      joinedAt: user.createdAt,
    },
    stats,
    access,
    dm,
    blocked: blocks.byX ? 'by_me' : null,
  };
  if (!open) return result;
  const [readings, owned] = await Promise.all([db.members.readings(id), db.series.list(id)]);
  const nfts = owned.filter((s) => s.convertedAt);
  return {
    ...result,
    readings: readings.map((r) => ({
      id: r.id,
      clue: r.clue,
      question: r.question,
      generatedAt: r.generatedAt,
      coherent: r.verdict === 'pass',
      interpretation: r.interpretation ?? '',
    })),
    nfts: await series.withBadges(nfts),
  };
}

/** Asks a member to see their readings and NFTs. Resolves to { access }. */
async function requestAccess(viewer, id) {
  if (id === viewer.id) throw ApiError.badRequest('OWN_PROFILE', 'This is your own profile.');
  await reachableMember(viewer, id);
  const { byX: blockedThem } = await db.dms.blocksBetween(viewer.id, id);
  if (blockedThem) throw ApiError.conflict('YOU_BLOCKED', 'You have blocked this member.');
  const access = await db.members.requestAccess(id, viewer.id);
  return { access: access.status };
}

/** Requests to see the user's profile, waiting for an answer: { requests: [{ id, createdAt, viewer }] }. */
async function pendingRequests(owner) {
  const rows = await db.members.pendingFor(owner.id);
  return { requests: rows.map((r) => ({ id: r.id, createdAt: r.createdAt, viewer: publicUser(r.viewer) })) };
}

/** Approves or denies a request to see the user's profile. Resolves to { status }. */
async function answer(owner, requestId, approve) {
  const updated = await db.members.answerAccess(owner.id, requestId, approve ? 'approved' : 'denied');
  if (!updated) throw ApiError.notFound('REQUEST_NOT_FOUND', 'Request not found.');
  return { status: updated.status };
}

/** Takes back a viewer's access to the user's readings and NFTs. */
async function revoke(owner, viewerId) {
  await db.members.revokeAccess(owner.id, viewerId);
  return { revoked: true };
}

module.exports = { profile, requestAccess, pendingRequests, answer, revoke };
