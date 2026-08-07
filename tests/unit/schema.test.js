import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://x:x@localhost:5432/x';
process.env.JWT_SECRET ??= 'test-secret-that-is-long-enough-for-zod-0123';
process.env.COOKIE_SECRET ??= 'test-secret-that-is-long-enough-for-zod-0123';
process.env.HASH_PEPPER ??= 'test-secret-that-is-long-enough-for-zod-0123';

const { createPollSchema } = await import('../../src/modules/polls/polls.schema.js');
const { trustProxyValue, CLOUDFLARE_IPV4 } = await import('../../src/config/trust-proxy.js');

const question = (over = {}) => ({
  type: 'single_choice',
  prompt: 'Where should we meet?',
  options: [{ label: 'Yaba' }, { label: 'Lekki' }],
  ...over,
});

test('a valid quick vote parses', () => {
  const parsed = createPollSchema.parse({
    type: 'vote',
    title: 'Team lunch',
    questions: [question()],
  });
  assert.equal(parsed.dedupMode, 'cookie_device'); // safe default
  assert.equal(parsed.visibility, 'unlisted');
});

test('a quick vote cannot carry more than one question', () => {
  const result = createPollSchema.safeParse({
    type: 'vote',
    title: 'Two questions',
    questions: [question(), question()],
  });
  assert.equal(result.success, false);
});

test('choice questions need at least two options', () => {
  const result = createPollSchema.safeParse({
    type: 'vote',
    title: 'One option',
    questions: [question({ options: [{ label: 'Only' }] })],
  });
  assert.equal(result.success, false);
});

test('text questions cannot carry options', () => {
  const result = createPollSchema.safeParse({
    type: 'survey',
    title: 'Text with options',
    questions: [question({ type: 'short_text', options: [{ label: 'nope' }] })],
  });
  assert.equal(result.success, false);
});

test('an image-only option is accepted', () => {
  const parsed = createPollSchema.parse({
    type: 'vote',
    title: 'Logo vote',
    questions: [
      question({ options: [{ imagePublicId: 'pollhub/a' }, { imagePublicId: 'pollhub/b' }] }),
    ],
  });
  assert.equal(parsed.questions[0].options.length, 2);
});

test('closesAt must follow opensAt', () => {
  const result = createPollSchema.safeParse({
    type: 'vote',
    title: 'Backwards schedule',
    opensAt: '2026-09-02T10:00:00Z',
    closesAt: '2026-09-01T10:00:00Z',
    questions: [question()],
  });
  assert.equal(result.success, false);
});

test('account_required with dedup none is rejected as a footgun', () => {
  const result = createPollSchema.safeParse({
    type: 'vote',
    title: 'Login but unlimited votes',
    identityMode: 'account_required',
    dedupMode: 'none',
    questions: [question()],
  });
  assert.equal(result.success, false);
});

test('trust proxy is never boolean true', () => {
  const value = trustProxyValue();
  assert.notEqual(value, true);
  assert.ok(Array.isArray(value));
});

test('cloudflare ranges are included only when behind cloudflare', async () => {
  // Default env has BEHIND_CLOUDFLARE=false, so edge ranges must be absent.
  const value = trustProxyValue();
  assert.ok(!value.includes(CLOUDFLARE_IPV4[0]));
  assert.ok(value.includes('loopback'));
});
