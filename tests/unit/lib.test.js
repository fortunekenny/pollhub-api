import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://x:x@localhost:5432/x';
process.env.JWT_SECRET ??= 'test-secret-that-is-long-enough-for-zod-0123';
process.env.COOKIE_SECRET ??= 'test-secret-that-is-long-enough-for-zod-0123';
process.env.HASH_PEPPER ??= 'test-secret-that-is-long-enough-for-zod-0123';

const { toCsv } = await import('../../src/lib/csv.js');
const { hashPassword, verifyPassword, identityHash, inviteCode } = await import(
  '../../src/lib/hash.js'
);
const { generateSlug, SLUG_PATTERN } = await import('../../src/lib/slug.js');

test('csv quotes fields containing commas and quotes', () => {
  const out = toCsv(['a', 'b'], [['x,y', 'he said "hi"']]);
  assert.ok(out.includes('"x,y"'));
  assert.ok(out.includes('"he said ""hi"""'));
});

test('csv neutralises formula injection from free-text answers', () => {
  const out = toCsv(['answer'], [['=cmd|calc']]);
  // Must not reach Excel as a live formula.
  assert.ok(out.includes("'=cmd|calc"));
});

test('password round-trips and rejects a wrong password', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.ok(stored.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('wrong password', stored), false);
});

test('password hashes are salted — same input, different stored value', async () => {
  const a = await hashPassword('same');
  const b = await hashPassword('same');
  assert.notEqual(a, b);
});

test('identityHash is deterministic and does not leak the raw value', () => {
  const ip = '102.89.34.7';
  assert.equal(identityHash(ip), identityHash(ip));
  assert.notEqual(identityHash(ip), identityHash('102.89.34.8'));
  assert.ok(!identityHash(ip).includes(ip));
});

test('slugs match the public pattern and avoid ambiguous characters', () => {
  for (let i = 0; i < 200; i += 1) {
    const slug = generateSlug();
    assert.match(slug, SLUG_PATTERN);
    assert.ok(!/[0OIl]/.test(slug), `slug contained an ambiguous character: ${slug}`);
  }
});

test('invite codes avoid ambiguous characters', () => {
  for (let i = 0; i < 100; i += 1) {
    assert.match(inviteCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  }
});
