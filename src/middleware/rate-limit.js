import { RateLimiterMemory } from 'rate-limiter-flexible';
import { query } from '../db/pool.js';
import { tooManyRequests } from '../lib/errors.js';

/**
 * Two tiers, both without Redis.
 *
 * In-process (RateLimiterMemory) covers the common case and is free. It works
 * because v1 is a single Node process — the moment a second instance exists,
 * these limits stop being global and only the Postgres tier still holds.
 */
function memoryLimiter({ points, duration, keyPrefix }) {
  const limiter = new RateLimiterMemory({ points, duration, keyPrefix });

  return async function limit(req, res, next) {
    const key = req.clientIp ?? 'unknown';
    try {
      const result = await limiter.consume(key);
      res.set('X-RateLimit-Remaining', String(result.remainingPoints));
      next();
    } catch (rejection) {
      const retryAfter = Math.ceil((rejection.msBeforeNext ?? duration * 1000) / 1000);
      res.set('Retry-After', String(retryAfter));
      throw tooManyRequests('Rate limit exceeded', { retryAfter });
    }
  };
}

export const authLimiter = memoryLimiter({ points: 10, duration: 60, keyPrefix: 'auth' });
export const writeLimiter = memoryLimiter({ points: 60, duration: 60, keyPrefix: 'write' });
export const readLimiter = memoryLimiter({ points: 300, duration: 60, keyPrefix: 'read' });
export const uploadLimiter = memoryLimiter({ points: 20, duration: 60, keyPrefix: 'upload' });

/**
 * Durable tier, backed by Postgres.
 *
 * Used for vote submission, where an in-memory counter resetting on deploy
 * would hand an attacker a fresh quota every restart. One upsert per attempt,
 * counted into a fixed window.
 */
export async function consumeDurable(key, { points, windowSeconds }) {
  const windowStart = new Date(
    Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000,
  );

  const { rows } = await query(
    `INSERT INTO rate_events (key, window_start, count)
          VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start)
     DO UPDATE SET count = rate_events.count + 1
       RETURNING count`,
    [key, windowStart],
  );

  const count = rows[0].count;
  if (count > points) {
    const retryAfter = Math.ceil((windowStart.getTime() + windowSeconds * 1000 - Date.now()) / 1000);
    throw tooManyRequests('Rate limit exceeded', { retryAfter: Math.max(retryAfter, 1) });
  }
  return count;
}

/** Vote attempts per IP per poll — durable across restarts. */
export function voteLimiter(pollId, ipHash) {
  return consumeDurable(`vote:${pollId}:${ipHash}`, { points: 30, windowSeconds: 3600 });
}
