const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const env = require('./config/env');
const { globalLimiter } = require('./middleware/rateLimit');
const { notFound, errorHandler } = require('./middleware/error');
const appRoutes = require('./modules/app/app.routes');
const onboardingRoutes = require('./modules/onboarding/onboarding.routes');
const authRoutes = require('./modules/auth/auth.routes');
const usersRoutes = require('./modules/users/users.routes');
const clueRoutes = require('./modules/clue/clue.routes');
const journalRoutes = require('./modules/journal/journal.routes');
const statsRoutes = require('./modules/stats/stats.routes');
const remindersRoutes = require('./modules/reminders/reminders.routes');
const cronRoutes = require('./modules/reminders/cron.routes');
const membershipRoutes = require('./modules/membership/membership.routes');
const seriesRoutes = require('./modules/series/series.routes');
const artworkRoutes = require('./modules/artwork/artwork.routes');
const communityRoutes = require('./modules/community/community.routes');
const marketRoutes = require('./modules/market/market.routes');

function createApp() {
  const app = express();

  if (env.TRUST_PROXY) app.set('trust proxy', 1); // behind Nginx / load balancer
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((o) => o.trim()),
    }),
  );
  // Journal entries may hold 50,000 characters (up to 4 bytes each); every other body stays small.
  app.use('/api/v1/journal', express.json({ limit: '256kb' }));
  app.use(express.json({ limit: '100kb' }));
  if (env.NODE_ENV === 'development') app.use(morgan('dev'));
  app.use(globalLimiter);

  const v1 = express.Router();
  v1.use('/', appRoutes); // /health, /app/config
  v1.use('/onboarding', onboardingRoutes);
  v1.use('/auth', authRoutes);
  v1.use('/users', usersRoutes);
  v1.use('/', clueRoutes); // /clue-string
  v1.use('/journal', journalRoutes);
  v1.use('/stats', statsRoutes);
  v1.use('/reminders', remindersRoutes);
  v1.use('/membership', membershipRoutes);
  v1.use('/series', seriesRoutes);
  v1.use('/artwork', artworkRoutes);
  v1.use('/market', marketRoutes);
  v1.use('/community', communityRoutes);
  v1.use('/internal', cronRoutes); // scheduler-only, guarded by CRON_SECRET
  app.use('/api/v1', v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
