// Loaded by Jest before any module: deterministic test configuration.
Object.assign(process.env, {
  AVATAR_MAX_MB: '1', // uploads go to an in-memory fake in tests, never to Cloudinary
  JOURNAL_PHOTO_MAX_MB: '1',
  NODE_ENV: 'test',
  // Each test file connects to its own in-memory database instead (helpers.js).
  DATABASE_URL: 'postgresql://placeholder/test',
  JWT_ACCESS_SECRET: 'test-access-secret-that-is-long-enough-123456',
  OTP_PEPPER: 'test-otp-pepper-1234567890',
  BCRYPT_ROUNDS: '4',
  RATE_LIMIT_ENABLED: 'false',
  RESET_CODE_RESEND_SECONDS: '30',
  LOGIN_MAX_FAILED_ATTEMPTS: '5',
  SMTP_HOST: '',
});
