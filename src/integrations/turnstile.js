import { env, features } from '../config/env.js';
import { logger } from '../lib/logger.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verify a Turnstile token server-side.
 *
 * Returns true when Turnstile is not configured — the challenge is an
 * escalation applied to suspicious traffic, not a hard gate on every vote.
 * Failing closed here would block all voting the moment Cloudflare has a
 * wobble, which trades a fraud risk for an outage.
 */
export async function verifyTurnstile(token, remoteIp) {
  if (!features.turnstile) return true;
  if (!token) return false;

  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);

    const res = await fetch(VERIFY_URL, { method: 'POST', body });
    const data = await res.json();
    if (!data.success) logger.info('turnstile rejected', { codes: data['error-codes'] });
    return Boolean(data.success);
  } catch (err) {
    logger.warn('turnstile verify threw', { err: err.message });
    return true; // fail open — see above
  }
}
