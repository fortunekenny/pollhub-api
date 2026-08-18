import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { env, features, clientOrigins } from './config/env.js';
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

const DOCS_PAGE = fileURLToPath(new URL('./docs/index.html', import.meta.url));

export function createApp() {
  const app = express();

  // Must come before anything that reads req.ip. An explicit allowlist, never
  // boolean true — see config/trust-proxy.js for why that distinction decides
  // whether deduplication works at all.
  app.set('trust proxy', trustProxyValue());
  app.disable('x-powered-by');

  app.use(helmet());
  // An allowlist once CLIENT_ORIGIN is set, which env.js requires in
  // production. Reflecting every origin while sending credentials is only
  // survivable because `lax` keeps the auth cookie at home; the device-id
  // cookie no longer stays home, so the origin has to be pinned instead.
  app.use(cors({ origin: clientOrigins.length > 0 ? clientOrigins : true, credentials: true }));
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser(env.COOKIE_SECRET));
  app.use(clientIp);

  app.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime(), features });
  });

  // Human-readable API reference at the root. Hitting the bare hostname is the
  // first thing anyone does with a deployed API, and a 404 there teaches them
  // nothing. Static HTML with no inline script, so helmet's default CSP
  // (script-src 'self') serves it untouched.
  app.get('/', (_req, res) => {
    res.sendFile(DOCS_PAGE);
  });

  const api = express.Router();
  api.use('/auth', authRoutes);

  // Order matters, and not cosmetically. pollRoutes calls `use(authenticate)`
  // partway down to gate its creator routes, and router-level middleware runs
  // for every request that enters the router — including paths it has no route
  // for. Mounted first, it would 401 a respondent submitting a vote before
  // responseRoutes was ever reached, which is exactly the login wall the
  // respondent path exists to avoid. Respondent routes therefore go first;
  // their paths (/:slug/responses, /:slug/status) cannot shadow anything in
  // pollRoutes.
  api.use('/polls', responseRoutes); // /polls/:slug/responses
  api.use('/polls', pollRoutes);
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
