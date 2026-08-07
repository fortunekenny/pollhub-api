import { Router } from 'express';
import * as c from './auth.controller.js';
import * as s from './auth.schema.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authLimiter } from '../../middleware/rate-limit.js';

export const authRoutes = Router();

authRoutes.post('/signup', authLimiter, validate({ body: s.signupSchema }), c.signup);
authRoutes.post('/login', authLimiter, validate({ body: s.loginSchema }), c.login);
authRoutes.post('/logout', c.logout);
authRoutes.get('/me', authenticate, c.me);

authRoutes.post('/verify-email', authLimiter, validate({ body: s.verifyEmailSchema }), c.verifyEmail);
authRoutes.post(
  '/password/request-reset',
  authLimiter,
  validate({ body: s.requestResetSchema }),
  c.requestPasswordReset,
);
authRoutes.post(
  '/password/reset',
  authLimiter,
  validate({ body: s.resetPasswordSchema }),
  c.resetPassword,
);

authRoutes.get('/google', authLimiter, c.googleStart);
authRoutes.get('/google/callback', authLimiter, c.googleCallback);
