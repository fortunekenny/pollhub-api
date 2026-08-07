import { Router } from 'express';
import { z } from 'zod';
import * as repo from './notifications.repository.js';
import { NOTIFICATION_EVENTS } from '../../config/constants.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { writeLimiter, readLimiter } from '../../middleware/rate-limit.js';

export const notificationRoutes = Router();

const registerSchema = z.object({
  token: z.string().min(10).max(500),
  provider: z.enum(['expo', 'fcm_web']),
  platform: z.enum(['ios', 'android', 'web']),
});

const prefsSchema = z.object({
  eventType: z.enum(NOTIFICATION_EVENTS),
  email: z.boolean().default(true),
  pushMobile: z.boolean().default(true),
  pushWeb: z.boolean().default(true),
});

notificationRoutes.use(authenticate);

notificationRoutes.post(
  '/tokens',
  writeLimiter,
  validate({ body: registerSchema }),
  async (req, res) => {
    const token = await repo.registerToken({ userId: req.user.id, ...req.body });
    res.status(201).json({ token: { id: token.id, platform: token.platform } });
  },
);

notificationRoutes.delete(
  '/tokens',
  writeLimiter,
  validate({ body: z.object({ token: z.string().min(10).max(500) }) }),
  async (req, res) => {
    await repo.revokeToken(req.body.token);
    res.status(204).end();
  },
);

notificationRoutes.get('/preferences', readLimiter, async (req, res) => {
  res.json({ preferences: await repo.allPrefs(req.user.id) });
});

notificationRoutes.put(
  '/preferences',
  writeLimiter,
  validate({ body: prefsSchema }),
  async (req, res) => {
    const { eventType, ...prefs } = req.body;
    res.json({ preference: await repo.setPrefs(req.user.id, eventType, prefs) });
  },
);
