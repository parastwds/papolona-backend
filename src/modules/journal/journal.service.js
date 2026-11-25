const crypto = require('crypto');
const db = require('../../db');
const { DuplicateError } = require('../../db/errors');
const ApiError = require('../../utils/ApiError');
const storage = require('../../utils/storage');
const ai = require('./insights.ai');

const PAGE_SIZE = 20;

// What Cloudinary puts after the folder: a random name. Anything else (sub-folders, "..") is refused.
const PHOTO_NAME = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The photos to store on an entry: only the user's own uploads (their Cloudinary folder), with the URL
 * built here from the publicId rather than taken from the app.
 */
function ownPhotos(userId, photos) {
  const prefix = `${storage.journalFolder(userId)}/`;
  return photos.map(({ publicId, width, height }) => {
    if (!publicId.startsWith(prefix) || !PHOTO_NAME.test(publicId.slice(prefix.length))) {
      throw ApiError.badRequest('INVALID_PHOTO', 'One of the photos could not be found. Please add it again.');
    }
    return { publicId, url: storage.journalPhotoUrl(publicId), width, height };
  });
}

/** Newest first, PAGE_SIZE per page; pass the last page's nextCursor as `before` for the next. */
function listEntries(userId, { before, limit = PAGE_SIZE }) {
  return db.journal.list(userId, { before, limit });
}

/**
 * Adds an entry. It stays open until the next draw seals it to that clue. The same clientId twice returns
 * the first entry, so retries are safe.
 */
async function createEntry(userId, { text, source, clientId, photos = [] }) {
  const stored = ownPhotos(userId, photos);
  try {
    return { entry: await db.journal.create({ userId, text, source, clientId, photos: stored, clueDrawId: null }), created: true };
  } catch (err) {
    if (!(err instanceof DuplicateError)) throw err;
    return { entry: await db.journal.findByClientId(userId, clientId), created: false };
  }
}

/** Seals every open entry to the clue just drawn. Called by the clue service after a draw. */
async function sealOpenEntries(userId, clueDrawId) {
  await db.journal.sealOpen(userId, clueDrawId);
}

/** Uploads one photo for an entry about to be written; the entry then refers to it by publicId. */
function uploadPhoto(userId, file) {
  return storage.saveJournalPhoto(file.buffer, userId);
}

/**
 * Deletes one entry for good, open or sealed: the journal is the user's own data.
 * Its photos are removed from Cloudinary too (best effort).
 */
async function deleteEntry(userId, id) {
  const removed = await db.journal.remove(userId, id);
  if (!removed) throw ApiError.notFound('ENTRY_NOT_FOUND', 'This journal entry no longer exists.');
  await storage.removeJournalPhotos(removed.photoIds);
  return { id };
}

/** "Clear all": deletes the entries not yet sealed by a clue, and their photos. Sealed entries are deleted one by one. */
async function clearOpenEntries(userId) {
  const { deleted, photoIds } = await db.journal.removeOpen(userId);
  await storage.removeJournalPhotos(photoIds);
  return { deleted };
}

/** Removes the whole journal, its photos and its AI readings (account deletion). */
async function deleteAllForUser(userId) {
  const { photoIds } = await db.journal.removeAllForUser(userId);
  await db.journalInsights.removeAllForUser(userId);
  await storage.removeJournalPhotos(photoIds);
}

/**
 * Calendar marks: when the user wrote and when they drew a clue, in [from, to).
 * The app groups the instants into its own local days.
 */
async function getCalendar(userId, { from, to }) {
  const [entries, readings] = await Promise.all([
    db.journal.createdBetween(userId, from, to),
    db.clueDraws.generatedBetween(userId, from, to),
  ]);
  return { entries, readings };
}

// Which entries (and which wording) a reading was made from, and with which prompt; any change to
// either means the saved reading is out of date.
const hashEntries = (entries) =>
  crypto
    .createHash('sha256')
    .update(`v${ai.PROMPT_VERSION}\u0002`)
    .update(entries.map((e) => `${e.id}\u0000${e.text}\u0000${e.clue?.clue ?? ''}`).join('\u0001'))
    .digest('hex');

/**
 * The AI reading of one journal day: the entries refined into one reflection.
 * `day` is the user's local date and [from, to) its start and end, from the app (which knows the time zone).
 * The saved reading is reused while the day's entries are unchanged; `refresh` asks the AI again.
 */
async function getDayInsights(userId, { day, from, to }, { refresh = false } = {}) {
  const entries = await db.journal.listBetween(userId, from, to);
  if (!entries.length) throw ApiError.notFound('NO_ENTRIES', 'There are no journal entries for this day.');

  const entriesHash = hashEntries(entries);
  const saved = await db.journalInsights.find(userId, day);
  if (saved && saved.entriesHash === entriesHash && !refresh) return toPublicInsight(saved, entries.length);

  const reading = await ai.readDay(entries);
  const stored = await db.journalInsights.save(userId, day, { entriesHash, ...reading });
  return toPublicInsight(stored, entries.length);
}

const toPublicInsight = (insight, entryCount) => ({
  day: insight.day,
  refined: insight.refined,
  model: insight.model,
  generatedAt: insight.generatedAt,
  entryCount,
});

module.exports = {
  listEntries,
  createEntry,
  uploadPhoto,
  sealOpenEntries,
  deleteEntry,
  clearOpenEntries,
  deleteAllForUser,
  getCalendar,
  getDayInsights,
  PAGE_SIZE,
};
