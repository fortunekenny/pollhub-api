import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { validate } from '../../middleware/validate.js';
import { authenticate, optionalAuth, requireRole } from '../../middleware/authenticate.js';
import { writeLimiter, readLimiter } from '../../middleware/rate-limit.js';
import { notFound } from '../../lib/errors.js';
import { evict } from '../../realtime/tally-mirror.js';

export const moderationRoutes = Router();

const reportSchema = z.object({
  pollId: z.string().uuid(),
  reason: z.string().trim().min(3).max(1000),
});

const idParam = z.object({ id: z.string().uuid() });

/**
 * Anyone can report, signed in or not — a respondent who hits an abusive poll
 * from a shared link has no account and must still be able to flag it.
 */
moderationRoutes.post(
  '/reports',
  writeLimiter,
  optionalAuth,
  validate({ body: reportSchema }),
  async (req, res) => {
    const { rows } = await pool.query(
      `INSERT INTO reports (poll_id, reporter_id, reason)
            VALUES ($1,$2,$3) RETURNING id, created_at`,
      [req.body.pollId, req.user?.id ?? null, req.body.reason],
    );
    res.status(201).json({ report: rows[0] });
  },
);

// --- admin ----------------------------------------------------------------
moderationRoutes.use(authenticate, requireRole('admin'));

moderationRoutes.get('/reports', readLimiter, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.reason, r.status, r.created_at,
            p.id AS poll_id, p.title, p.slug, p.status AS poll_status
       FROM reports r
       JOIN polls p ON p.id = r.poll_id
      WHERE r.status = 'open'
      ORDER BY r.created_at
      LIMIT 100`,
  );
  res.json({ reports: rows });
});

/** Uphold a report: archive the poll and stop broadcasting its results. */
moderationRoutes.post(
  '/reports/:id/uphold',
  writeLimiter,
  validate({ params: idParam }),
  async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE reports SET status = 'upheld', resolved_at = now()
        WHERE id = $1 AND status = 'open'
    RETURNING poll_id`,
      [req.validatedParams.id],
    );
    if (!rows[0]) throw notFound('Report not found or already resolved');

    await pool.query(`UPDATE polls SET status = 'archived' WHERE id = $1`, [rows[0].poll_id]);
    evict(rows[0].poll_id);
    res.json({ ok: true, pollId: rows[0].poll_id });
  },
);

moderationRoutes.post(
  '/reports/:id/dismiss',
  writeLimiter,
  validate({ params: idParam }),
  async (req, res) => {
    await pool.query(
      `UPDATE reports SET status = 'dismissed', resolved_at = now() WHERE id = $1`,
      [req.validatedParams.id],
    );
    res.json({ ok: true });
  },
);

moderationRoutes.post(
  '/users/:id/suspend',
  writeLimiter,
  validate({ params: idParam }),
  async (req, res) => {
    await pool.query('UPDATE users SET suspended_at = now() WHERE id = $1', [
      req.validatedParams.id,
    ]);
    res.json({ ok: true });
  },
);
