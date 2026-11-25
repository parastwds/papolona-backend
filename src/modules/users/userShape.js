/** Rules about a user object from the db layer, the same for every database driver. */

const isLocked = (user) => !!(user.lockUntil && user.lockUntil > new Date());

/** Shape returned to the app. Never includes secrets or security counters. */
const toPublicUser = (user, { showCohort = true } = {}) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  phone: user.phone ?? null,
  role: user.role,
  status: user.status,
  memberSince: user.memberSince ?? null,
  membershipType: user.membershipType ?? null,
  emailVerified: !!user.emailVerifiedAt,
  cohort: showCohort ? user.cohort : undefined,
  profile: {
    bio: user.profile?.bio ?? '',
    country: user.profile?.country ?? null,
    timezone: user.profile?.timezone ?? null,
    avatarUrl: user.profile?.avatarUrl ?? null,
  },
  legal: {
    termsVersion: user.legal?.termsVersion ?? null,
    privacyVersion: user.legal?.privacyVersion ?? null,
    acceptedAt: user.legal?.acceptedAt ?? null,
  },
  createdAt: user.createdAt,
});

module.exports = { isLocked, toPublicUser };
