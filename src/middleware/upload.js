const multer = require('multer');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

// Detected from the file's first bytes; the client-sent Content-Type and file name are not trusted.
const IMAGE_SIGNATURES = [
  { ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', test: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];

const detectImageType = (buffer) => IMAGE_SIGNATURES.find((s) => s.test(buffer))?.ext ?? null;

/**
 * Accepts a single image in the multipart field `field`, kept in memory.
 * On success req.file.ext holds the detected extension (jpg | png | webp).
 */
const singleImage = (field, maxMb) => {
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.round(maxMb * 1024 * 1024), files: 1, fields: 0 },
  }).single(field);

  return (req, res, next) => {
    parse(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(413, 'FILE_TOO_LARGE', `The photo must be ${maxMb} MB or smaller.`));
        }
        return next(ApiError.badRequest('INVALID_UPLOAD', `Send one image in the "${field}" form field.`));
      }
      if (err) return next(err);
      if (!req.file) return next(ApiError.badRequest('FILE_REQUIRED', `Send an image in the "${field}" form field.`));

      req.file.ext = detectImageType(req.file.buffer);
      if (!req.file.ext) return next(ApiError.badRequest('UNSUPPORTED_FILE_TYPE', 'Use a JPG, PNG or WebP image.'));
      next();
    });
  };
};

const avatarUpload = singleImage('avatar', env.AVATAR_MAX_MB);
const journalPhotoUpload = singleImage('photo', env.JOURNAL_PHOTO_MAX_MB);

module.exports = { avatarUpload, journalPhotoUpload, detectImageType };
