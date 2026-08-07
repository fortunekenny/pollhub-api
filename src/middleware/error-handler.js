import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isProd } from '../config/env.js';

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'not_found', `No route for ${req.method} ${req.originalUrl}`));
}

/**
 * Terminal error handler.
 *
 * Express 5 forwards rejected promises from async handlers here on its own,
 * which is why no route in this codebase wraps itself in try/catch.
 */
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: {
        code: 'validation_failed',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error(err.message, { code: err.code });
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  if (err?.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
  }

  logger.error('unhandled error', {
    err: err?.message,
    stack: err?.stack,
    path: req.originalUrl,
  });

  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Something went wrong',
      // Never leak internals in production; always show them locally.
      ...(isProd ? {} : { detail: err?.message }),
    },
  });
}
