import { env } from '../config/env.js';

/**
 * Resolve the true client IP and hang it on `req.clientIp`.
 *
 * Why this exists at all: every request arrives through a proxy, so `req.ip`
 * is the proxy's address. Left alone, every voter hashes to the same value —
 * the `(poll_id, ip_hash)` unique index rejects the second voter on every
 * poll, and IP rate limiting locks out the whole world at once.
 *
 * `CF-Connecting-IP` is trusted ONLY when Express has already decided the
 * immediate peer is a trusted proxy (see config/trust-proxy.js). Trusting it
 * unconditionally is worse than no deduplication at all: an attacker sets the
 * header per request and mints a fresh identity per vote, while the results
 * page still claims the poll was protected.
 */
export function clientIp(req, _res, next) {
  if (env.BEHIND_CLOUDFLARE) {
    const cf = req.get('cf-connecting-ip');
    // req.ip already reflects the trust-proxy allowlist, so if Express did not
    // strip a hop, the peer is not a trusted proxy and the header is a forgery.
    if (cf && isFromTrustedProxy(req)) {
      req.clientIp = cf.trim();
      return next();
    }
  }
  req.clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  next();
}

/**
 * Express sets `req.ips` to the trusted portion of X-Forwarded-For. A
 * non-empty value means at least one hop was accepted as trusted.
 */
function isFromTrustedProxy(req) {
  return Array.isArray(req.ips) && req.ips.length > 0;
}
