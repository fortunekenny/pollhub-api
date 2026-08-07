import { Router } from 'express';
import { z } from 'zod';
import { signUpload } from '../../integrations/cloudinary.js';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { uploadLimiter } from '../../middleware/rate-limit.js';

export const uploadRoutes = Router();

const signSchema = z.object({
  kind: z.enum(['option', 'cover', 'avatar']),
});

/**
 * Mint an upload signature.
 *
 * The client then uploads directly to Cloudinary — image bytes never pass
 * through this server, which is what keeps a 1 GB e2-micro viable. Requires
 * auth so anonymous respondents cannot burn the Cloudinary credit pool.
 */
uploadRoutes.post(
  '/sign',
  authenticate,
  uploadLimiter,
  validate({ body: signSchema }),
  (req, res) => {
    const folder = `pollhub/${req.body.kind}`;
    res.json({ upload: signUpload({ folder }) });
  },
);
