import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '../config/env.js';

const scrypt = promisify(crypto.scrypt);

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

/**
 * Password hashing via Node's built-in scrypt.
 *
 * Deliberately no bcrypt/argon2: both are native modules, and the deploy
 * target is a bare ARM VM with no Docker. A native build failing on the
 * server is a bad way to discover a dependency choice.
 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return `scrypt$${SCRYPT_OPTS.N}$${SCRYPT_OPTS.r}$${SCRYPT_OPTS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, N, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scrypt(password, salt, expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Keyed hash for identity signals (IP, device fingerprint, invite codes).
 *
 * Peppered so a database leak does not hand out a rainbow table of voter IPs
 * — the raw address is never stored, and the brief commits to that.
 */
export function identityHash(value) {
  return crypto.createHmac('sha256', env.HASH_PEPPER).update(String(value)).digest('hex');
}

/** URL-safe random token, returned raw; store only its hash. */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Short human-enterable invite code, e.g. K3F9-2QMX. */
export function inviteCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
  const pick = () =>
    Array.from(crypto.randomBytes(4))
      .map((b) => alphabet[b % alphabet.length])
      .join('');
  return `${pick()}-${pick()}`;
}
