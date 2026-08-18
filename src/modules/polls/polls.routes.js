import { Router } from 'express';
import * as c from './polls.controller.js';
import * as s from './polls.schema.js';
import { validate } from '../../middleware/validate.js';
import { authenticate, optionalAuth } from '../../middleware/authenticate.js';
import { readLimiter, writeLimiter } from '../../middleware/rate-limit.js';

export const pollRoutes = Router();

// --- public ---------------------------------------------------------------
// optionalAuth, never authenticate: a login wall on the respondent page is
// the single biggest source of drop-off the brief identifies.
pollRoutes.get(
  '/public',
  readLimiter,
  validate({ query: s.listPollsSchema }),
  c.listPublic,
);

pollRoutes.get(
  '/slug/:slug',
  readLimiter,
  optionalAuth,
  validate({ params: s.slugParam }),
  c.getBySlug,
);

pollRoutes.get('/:id/qr.svg', readLimiter, validate({ params: s.pollIdParam }), c.qr);

// --- creator --------------------------------------------------------------
pollRoutes.use(authenticate);

pollRoutes.post('/', writeLimiter, validate({ body: s.createPollSchema }), c.create);
pollRoutes.get('/', readLimiter, validate({ query: s.listPollsSchema }), c.list);
pollRoutes.get('/:id', readLimiter, validate({ params: s.pollIdParam }), c.getOne);

pollRoutes.patch(
  '/:id',
  writeLimiter,
  validate({ params: s.pollIdParam, body: s.updatePollSchema }),
  c.update,
);

pollRoutes.post('/:id/publish', writeLimiter, validate({ params: s.pollIdParam }), c.publish);
pollRoutes.post('/:id/close', writeLimiter, validate({ params: s.pollIdParam }), c.close);
pollRoutes.post('/:id/archive', writeLimiter, validate({ params: s.pollIdParam }), c.archive);

// Role decides which statuses this accepts — see polls.service.remove.
pollRoutes.delete('/:id', writeLimiter, validate({ params: s.pollIdParam }), c.remove);
