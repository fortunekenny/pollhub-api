import { Router } from 'express';
import { z } from 'zod';
import * as repo from './invites.repository.js';
import { getOwned } from '../polls/polls.service.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { writeLimiter, readLimiter } from '../../middleware/rate-limit.js';
import { inviteCode } from '../../lib/hash.js';
import { sendEmail } from '../../integrations/brevo.js';
import { env } from '../../config/env.js';

export const inviteRoutes = Router();

const idParam = z.object({ id: z.string().uuid() });
const issueSchema = z.object({
  count: z.number().int().min(1).max(500).optional(),
  emails: z.array(z.string().email()).max(500).optional(),
});

inviteRoutes.use(authenticate);

/**
 * Issue one-time codes.
 *
 * Codes are returned in plaintext exactly once, here. Only their hash is
 * stored, so a database leak does not hand out working ballots.
 */
inviteRoutes.post(
  '/:id/invites',
  writeLimiter,
  validate({ params: idParam, body: issueSchema }),
  async (req, res) => {
    const poll = await getOwned(req.validatedParams.id, req.user.id);
    const emails = req.body.emails ?? [];
    const total = emails.length > 0 ? emails.length : (req.body.count ?? 10);

    const codes = Array.from({ length: total }, (_, i) => ({
      code: inviteCode(),
      email: emails[i] ?? null,
    }));

    await repo.insertCodes(poll.id, codes, null);

    for (const c of codes.filter((c) => c.email)) {
      await sendEmail({
        to: c.email,
        subject: `You're invited to vote: ${poll.title}`,
        html: `<p>You have been invited to take part in <strong>${poll.title}</strong>.</p>
               <p>Your one-time code: <code>${c.code}</code></p>
               <p><a href="${env.PUBLIC_POLL_BASE_URL}/${poll.slug}">Open the poll</a></p>`,
      });
    }

    res.status(201).json({ codes: codes.map((c) => ({ code: c.code, email: c.email })) });
  },
);

inviteRoutes.get(
  '/:id/invites',
  readLimiter,
  validate({ params: idParam }),
  async (req, res) => {
    const poll = await getOwned(req.validatedParams.id, req.user.id);
    res.json({
      invites: await repo.listForPoll(poll.id),
      stats: await repo.stats(poll.id),
    });
  },
);
