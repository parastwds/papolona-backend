const crypto = require('crypto');
const { v2: cloudinary } = require('cloudinary');
const env = require('../config/env');
const ApiError = require('./ApiError');
const logger = require('./logger');

const configured = !!(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
if (configured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

/** In tests, uploads are kept here (public_id -> url) instead of going to Cloudinary. */
const uploads = new Map();

const fakeUrl = (publicId) => `https://res.cloudinary.com/test/image/upload/${publicId}`;
const randomName = () => crypto.randomBytes(10).toString('hex');

/** One image upload; any Cloudinary error becomes 502 UPLOAD_FAILED. */
async function upload(buffer, options) {
  if (!configured) throw new ApiError(503, 'UPLOADS_UNAVAILABLE', 'Photo uploads are not available right now.');
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        { resource_type: 'image', allowed_formats: ['jpg', 'png', 'webp'], overwrite: false, ...options },
        (err, res) => (err ? reject(err) : resolve(res)),
      )
      .end(buffer);
  }).catch((err) => {
    logger.error('Cloudinary upload failed', err);
    throw new ApiError(502, 'UPLOAD_FAILED', 'We could not upload your photo. Please try again.');
  });
}

/**
 * Uploads the image to Cloudinary, cropped to a 512x512 square centred on the face.
 * Returns { publicId, url } where url is the HTTPS delivery URL.
 */
async function saveAvatar(buffer) {
  if (env.NODE_ENV === 'test') {
    const publicId = `${env.CLOUDINARY_FOLDER}/${randomName()}`;
    const url = fakeUrl(publicId);
    uploads.set(publicId, url);
    return { publicId, url };
  }

  const result = await upload(buffer, {
    folder: env.CLOUDINARY_FOLDER,
    transformation: [{ width: 512, height: 512, crop: 'fill', gravity: 'face' }],
  });
  return { publicId: result.public_id, url: result.secure_url };
}

/** Best-effort delete: a Cloudinary error must never fail the request. */
async function removeAvatar(publicId) {
  if (!publicId) return;
  if (env.NODE_ENV === 'test') {
    uploads.delete(publicId);
    return;
  }
  if (!configured) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
  } catch (err) {
    logger.error('Cloudinary delete failed', err);
  }
}

/** Each user's journal photos live in their own folder, so an entry can only attach that user's uploads. */
const journalFolder = (userId) => `${env.CLOUDINARY_JOURNAL_FOLDER}/${userId}`;

/** The HTTPS delivery URL of a stored photo, always built here: a URL sent by the app is never trusted. */
const journalPhotoUrl = (publicId) =>
  env.NODE_ENV === 'test' || !configured ? fakeUrl(publicId) : cloudinary.url(publicId, { secure: true });

/**
 * Uploads a journal photo as the user took it (no crop), only scaled down to 2000px on the long side.
 * Returns { publicId, url, width, height }, the size being that of the stored image.
 */
async function saveJournalPhoto(buffer, userId) {
  if (env.NODE_ENV === 'test') {
    const publicId = `${journalFolder(userId)}/${randomName()}`;
    uploads.set(publicId, fakeUrl(publicId));
    return { publicId, url: fakeUrl(publicId), width: 1200, height: 900 };
  }

  const result = await upload(buffer, {
    folder: journalFolder(userId),
    transformation: [{ width: 2000, height: 2000, crop: 'limit' }],
  });
  return { publicId: result.public_id, url: result.secure_url, width: result.width, height: result.height };
}

/** Best-effort delete of journal photos, a few at a time; never fails the request. */
async function removeJournalPhotos(publicIds) {
  const ids = (publicIds ?? []).filter(Boolean);
  if (!ids.length) return;
  if (env.NODE_ENV === 'test') {
    ids.forEach((id) => uploads.delete(id));
    return;
  }
  if (!configured) return;
  for (let i = 0; i < ids.length; i += 10) {
    const results = await Promise.allSettled(
      ids.slice(i, i + 10).map((id) => cloudinary.uploader.destroy(id, { resource_type: 'image', invalidate: true })),
    );
    results.filter((r) => r.status === 'rejected').forEach((r) => logger.error('Cloudinary delete failed', r.reason));
  }
}

module.exports = {
  saveAvatar,
  removeAvatar,
  journalFolder,
  journalPhotoUrl,
  saveJournalPhoto,
  removeJournalPhotos,
  uploads,
};
