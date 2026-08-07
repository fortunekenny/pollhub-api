import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { forbidden, unauthorized } from '../lib/errors.js';

function readToken(req) {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return req.signedCookies?.ph_at ?? null;
}

function verify(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET, { issuer: 'pollhub' });
  } catch {
    return null;
  }
}

/** Hard requirement: 401 when no valid token is present. */
export function authenticate(req, _res, next) {
  const token = readToken(req);
  if (!token) throw unauthorized();

  const payload = verify(token);
  if (!payload) throw unauthorized('Invalid or expired token');

  req.user = { id: payload.sub, role: payload.role, email: payload.email };
  next();
}

/**
 * Soft variant for respondent routes.
 *
 * A poll set to `account_required` needs to know who is voting, but a public
 * poll must never 401 someone who simply is not signed in — the brief treats
 * the login wall as the main cause of respondent drop-off.
 */
export function optionalAuth(req, _res, next) {
  const token = readToken(req);
  if (token) {
    const payload = verify(token);
    if (payload) req.user = { id: payload.sub, role: payload.role, email: payload.email };
  }
  next();
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden(`Requires role: ${roles.join(' or ')}`);
    next();
  };
}
