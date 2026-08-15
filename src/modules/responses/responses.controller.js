import crypto from 'node:crypto';
import { crossSiteCookie } from '../../config/env.js';
import { DEDUP_COOKIE, DEDUP_COOKIE_MAX_AGE_MS } from '../../config/constants.js';
import * as service from './responses.service.js';
import * as pollRepo from '../polls/polls.repository.js';
import { canSeeResults } from '../polls/polls.service.js';
import { notFound } from '../../lib/errors.js';

/**
 * Read the device id from a SIGNED cookie, minting one if absent.
 *
 * Signed because the default dedup mode trusts this value: an unsigned cookie
 * is a field the voter edits to mint a new identity per vote.
 *
 * `crossSiteCookie` rather than a plain `sameSite: 'lax'`: in production the
 * client is a separate origin, and a lax cookie is not sent on a cross-site
 * fetch. The cookie would never come back, this function would mint a fresh id
 * on every submission, and `cookie_device` dedup would quietly recognise
 * nobody — no error, just results that stopped being deduplicated.
 */
function deviceId(req, res) {
  const existing = req.signedCookies?.[DEDUP_COOKIE];
  if (existing) return existing;

  const fresh = crypto.randomUUID();
  res.cookie(DEDUP_COOKIE, fresh, {
    httpOnly: true,
    signed: true,
    ...crossSiteCookie,
    maxAge: DEDUP_COOKIE_MAX_AGE_MS,
    path: '/',
  });
  return fresh;
}

export async function submit(req, res) {
  const result = await service.submit({
    slug: req.validatedParams.slug,
    input: req.body,
    context: {
      clientIp: req.clientIp,
      userId: req.user?.id ?? null,
      deviceId: deviceId(req, res),
      fingerprint: req.body.fingerprint,
      userAgent: req.get('user-agent'),
    },
  });

  const poll = await pollRepo.findById(result.response.poll_id);
  const showResults = canSeeResults(poll, {
    isOwner: req.user?.id === poll.owner_id,
    hasResponded: true,
  });

  res.status(201).json({
    responseId: result.response.id,
    responseCount: result.responseCount,
    resultsVisible: showResults,
    tallies: showResults
      ? Object.fromEntries(result.tallies.map((t) => [t.option_id, t.count]))
      : undefined,
    // Ranking standings move with the sum of positions, not the count. Sent
    // alongside so the confirmation screen can include the response that was
    // just submitted instead of showing figures that predate it.
    rankSums: showResults
      ? Object.fromEntries(result.tallies.map((t) => [t.option_id, Number(t.rank_sum)]))
      : undefined,
  });
}

/** Lets the respondent page render "you already voted" before showing a form. */
export async function status(req, res) {
  const poll = await pollRepo.findBySlug(req.validatedParams.slug);
  if (!poll) throw notFound('Poll not found');

  const responded = await service.hasResponded(poll.id, {
    clientIp: req.clientIp,
    userId: req.user?.id ?? null,
    deviceId: req.signedCookies?.[DEDUP_COOKIE] ?? null,
  });

  res.json({ hasResponded: responded, dedupMode: poll.dedup_mode });
}
