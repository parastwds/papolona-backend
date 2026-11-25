const db = require('../../db');
const ApiError = require('../../utils/ApiError');
const series = require('../series/series.service');

/**
 * The collective artwork: every series members have published, as one public, ever-growing wall of
 * thumbnails. Each tile opens to its badges and the meanings of its readings (a sublayer that an
 * eventual NFT keeps hidden), and links to its owner's gallery.
 */

/** A member's public name: first name and last initial ("Ada L."). */
function publicName(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? 'Member';
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** Published series as wall tiles, each with its badges, its owner and the member who completed it. */
async function toTiles(rows) {
  const shaped = await series.withBadges(rows);
  return shaped.map((s, i) => ({
    ...s,
    owner: { id: rows[i].owner.id, name: publicName(rows[i].owner.name) },
    creator: { id: rows[i].creator.id, name: publicName(rows[i].creator.name) },
  }));
}

/** A page of the wall, newest first. `before` is the publishedAt of the last tile already shown. */
async function wall({ before, limit = 30 }) {
  const rows = await db.series.listPublished({ before, limit });
  const tiles = await toTiles(rows);
  return { tiles, nextBefore: rows.length === limit ? rows[rows.length - 1].publishedAt : null };
}

/**
 * One tile opened: the series, its badges, owner and maker, and each of its readings in full: the clue,
 * the maker's interpretation, how the judge read each part, and the judge's feedback.
 */
async function tile(id) {
  const row = await db.series.findPublished(id);
  if (!row) throw ApiError.notFound('ARTWORK_NOT_FOUND', 'This artwork is not on the wall.');
  const [shaped] = await toTiles([row]);
  const readings = (await db.series.readings(id)).map((r) => ({
    id: r.id,
    clue: r.clue,
    interpretation: r.interpretation,
    parts: r.judgement?.parts ?? [],
    feedback: r.judgement?.feedback ?? null,
    tileIndex: r.tileIndex,
    generatedAt: r.generatedAt,
  }));
  return { tile: shaped, readings };
}

/** A member's gallery: their published series. */
async function memberGallery(userId) {
  const user = await db.users.findById(userId);
  if (!user) throw ApiError.notFound('MEMBER_NOT_FOUND', 'Member not found.');
  const tiles = await toTiles(await db.series.listPublishedByUser(userId));
  return { member: { id: user.id, name: publicName(user.name), memberSince: user.memberSince ?? null }, tiles };
}

/** The user's own badges, for their profile. */
const myBadges = async (userId) => ({ badges: await db.badges.listForUser(userId) });

module.exports = { wall, tile, memberGallery, myBadges, publicName };
