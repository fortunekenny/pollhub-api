import crypto from 'node:crypto';

// Base58: no 0/O/I/l, so a slug read aloud or off a QR code survives.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Short, unguessable poll slug — `pollhub.app/p/<slug>`. */
export function generateSlug(length = 8) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export const SLUG_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{6,16}$/;
