import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { env, features } from './config/env.js';
import { trustProxyValue } from './config/trust-proxy.js';
import { clientIp } from './middleware/client-ip.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';

import { authRoutes } from './modules/auth/auth.routes.js';
import { pollRoutes } from './modules/polls/polls.routes.js';
import { responseRoutes } from './modules/responses/responses.routes.js';
import { inviteRoutes } from './modules/invites/invites.routes.js';
import { analyticsRoutes } from './modules/analytics/analytics.routes.js';
import { uploadRoutes } from './modules/uploads/uploads.routes.js';
import { notificationRoutes } from './modules/notifications/notifications.routes.js';
import { moderationRoutes } from './modules/moderation/moderation.routes.js';

export function createApp() {
  const app = express();

  // Must come before anything that reads req.ip. An explicit allowlist, never
  // boolean true — see config/trust-proxy.js for why that distinction decides
  // whether deduplication works at all.
  app.set('trust proxy', trustProxyValue());
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser(env.COOKIE_SECRET));
  app.use(clientIp);

  app.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime(), features });
  });

  const api = express.Router();
  api.use('/auth', authRoutes);
  api.use('/polls', pollRoutes);
  api.use('/polls', responseRoutes); // /polls/:slug/responses
  api.use('/polls', inviteRoutes); // /polls/:id/invites
  api.use('/polls', analyticsRoutes); // /polls/:id/analytics
  api.use('/uploads', uploadRoutes);
  api.use('/notifications', notificationRoutes);
  api.use('/moderation', moderationRoutes);

  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
