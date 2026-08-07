import { Router } from 'express';
import * as c from './responses.controller.js';
import * as s from './responses.schema.js';
import { validate } from '../../middleware/validate.js';
import { optionalAuth } from '../../middleware/authenticate.js';
import { readLimiter, writeLimiter } from '../../middleware/rate-limit.js';

export const responseRoutes = Router();

// optionalAuth throughout: identity_mode decides whether an account is
// required, per poll — the route must not decide it for every poll at once.
responseRoutes.post(
  '/:slug/responses',
  writeLimiter,
  optionalAuth,
  validate({ params: s.slugParam, body: s.submitResponseSchema }),
  c.submit,
);

responseRoutes.get(
  '/:slug/status',
  readLimiter,
  optionalAuth,
  validate({ params: s.slugParam }),
  c.status,
);
