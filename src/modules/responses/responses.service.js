import { withTransaction, PG } from '../../db/transaction.js';
import * as repo from './responses.repository.js';
import * as pollRepo from '../polls/polls.repository.js';
import * as tallyRepo from '../tallies/tallies.repository.js';
import * as inviteRepo from '../invites/invites.repository.js';
import { identityHash } from '../../lib/hash.js';
import { CHOICE_TYPES, RESPONSE_MILESTONES } from '../../config/constants.js';
import { queryOne } from '../../db/pool.js';
import { notify, events } from '../notifications/notifications.service.js';
import { logger } from '../../lib/logger.js';
import { badRequest, conflict, forbidden, gone, unauthorized } from '../../lib/errors.js';
import { verifyTurnstile } from '../../integrations/turnstile.js';
import { voteLimiter } from '../../middleware/rate-limit.js';
import { applyDelta } from '../../realtime/tally-mirror.js';
import { publishTallyDelta } from '../../realtime/ws-server.js';

/**
 * Submit a response.
 *
 * Order matters: everything that can reject cheaply runs before the
 * transaction opens, so a rejected vote never holds a tally row lock.
 */
export async function submit({ slug, input, context }) {
  // Same resolution the respondent page used, so a vote cast through a series
  // link lands in whichever round that link opened.
  const poll = await pollRepo.resolveRespondentSlug(slug);
  if (!poll) throw badRequest('Poll not found');

  assertAcceptingResponses(poll);
  assertIdentity(poll, input, context);

  const ok = await verifyTurnstile(input.turnstileToken, context.clientIp);
  if (!ok) throw forbidden('Verification challenge failed');

  const ipHashValue = identityHash(context.clientIp);

  // Durable, Postgres-backed: an in-memory counter would hand an attacker a
  // fresh quota on every deploy.
  await voteLimiter(poll.id, ipHashValue);

  const dedup = buildDedupKeys(poll, context, ipHashValue);
  const answers = validateAnswers(poll.questions, input.answers);
  const chosen = answers.filter((a) => a.optionId);
  const optionIds = chosen.map((a) => a.optionId);
  // Carries the position too, so a ranking's rank_sum advances with its count.
  const optionEntries = chosen.map((a) => ({ optionId: a.optionId, rank: a.rank }));

  let inviteCodeId = null;
  if (poll.dedup_mode === 'invite_code') {
    inviteCodeId = await inviteRepo.claimCode(poll.id, input.inviteCode);
    if (!inviteCodeId) throw forbidden('That invite code is invalid or has already been used');
  }

  try {
    const { response, counts, responseCount } = await withTransaction(async (client) => {
      // The unique indexes on responses do the deduplication. There is no
      // check-then-insert here on purpose: a SELECT followed by an INSERT
      // leaves a window where two simultaneous votes both pass the check.
      const inserted = await repo.insertResponse(
        {
          pollId: poll.id,
          respondentUserId: dedup.userId,
          respondentName: input.respondentName,
          fingerprintHash: dedup.fingerprintHash,
          ipHash: dedup.ipHash,
          inviteCodeId,
          meta: { ua: context.userAgent?.slice(0, 200) },
        },
        client,
      );

      await repo.insertAnswers(inserted.id, answers, client);

      // Same client, same transaction as the insert above — this is the whole
      // reason repositories take a client instead of grabbing their own.
      const updated = await tallyRepo.incrementMany(poll.id, optionEntries, client);
      const total = await repo.bumpResponseCount(poll.id, client);

      return { response: inserted, counts: updated, responseCount: total };
    });

    // Post-commit only. Updating the mirror inside the transaction would
    // broadcast a vote that a rollback then erased.
    const delta = applyDelta(poll.id, optionIds);
    publishTallyDelta(
      poll.id,
      delta ?? Object.fromEntries(counts.map((c) => [c.option_id, c.count])),
      responseCount,
    );

    // Deliberately not awaited: the response is committed and the respondent
    // is owed a fast 201, not a wait on Brevo and FCM. Any failure inside is
    // logged, never surfaced — nobody's vote should fail because their poll
    // hit a round number.
    void notifyMilestone(poll, responseCount);

    return { response, responseCount, tallies: counts };
  } catch (err) {
    if (err.code === PG.UNIQUE_VIOLATION) {
      throw conflict('You have already responded to this poll', 'already_responded');
    }
    throw err;
  }
}

/**
 * Tell the owner when their poll crosses a milestone.
 *
 * Equality against the milestone list is what makes this fire exactly once
 * per threshold: bumpResponseCount returns the post-increment total, and it
 * advances by one, so each value is observed by exactly one submission. Two
 * simultaneous votes get two different totals from the same UPDATE.
 */
async function notifyMilestone(poll, responseCount) {
  if (!RESPONSE_MILESTONES.includes(responseCount)) return;

  try {
    const owner = await queryOne('SELECT email FROM users WHERE id = $1', [poll.owner_id]);
    await notify({
      userId: poll.owner_id,
      ...events.responseMilestone({ ...poll, response_count: responseCount }, responseCount),
      link: `/polls/${poll.id}`,
      data: { email: owner?.email, pollId: poll.id },
    });
  } catch (err) {
    logger.warn('milestone notify failed', { err: err.message, pollId: poll.id });
  }
}

function assertAcceptingResponses(poll) {
  if (poll.status === 'draft') throw badRequest('This poll has not been published');
  if (poll.status === 'archived') throw gone('This poll has been archived');
  if (poll.status === 'closed') throw gone('This poll is closed');

  const now = Date.now();
  if (poll.opens_at && new Date(poll.opens_at).getTime() > now) {
    throw badRequest('This poll has not opened yet');
  }
  // Checked here as well as by the scheduler: the cron job runs on an
  // interval, and a vote can arrive in the gap after closes_at passes.
  if (poll.closes_at && new Date(poll.closes_at).getTime() <= now) {
    throw gone('This poll is closed');
  }
}

function assertIdentity(poll, input, context) {
  if (poll.identity_mode === 'account_required' && !context.userId) {
    throw unauthorized('This poll requires you to sign in');
  }
  if (poll.identity_mode === 'name_required' && !input.respondentName) {
    throw badRequest('This poll requires your name');
  }
}

/**
 * Which identity column gets populated — and therefore which partial unique
 * index binds. Exactly one signal is set per mode; setting more would make a
 * poll reject voters for reasons its creator never chose.
 */
function buildDedupKeys(poll, context, ipHashValue) {
  const keys = { userId: null, fingerprintHash: null, ipHash: null };

  // Recorded whenever known, for the creator's own records.
  if (context.userId) keys.userId = context.userId;

  switch (poll.dedup_mode) {
    case 'none':
      // Nothing enforced. userId is still stored, so clear it to avoid the
      // account index rejecting a second deliberate response.
      keys.userId = null;
      break;
    case 'cookie_device':
      keys.fingerprintHash = identityHash(context.deviceId ?? context.fingerprint ?? ipHashValue);
      keys.userId = null;
      break;
    case 'ip':
      keys.ipHash = ipHashValue;
      keys.userId = null;
      break;
    case 'account':
      if (!context.userId) throw unauthorized('This poll requires you to sign in');
      break;
    case 'invite_code':
      keys.userId = null;
      break;
    default:
      break;
  }
  return keys;
}

/** Validate submitted answers against the poll's own questions. */
function validateAnswers(questions, submitted) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const seen = new Set();
  const rows = [];

  for (const answer of submitted) {
    const question = byId.get(answer.questionId);
    if (!question) throw badRequest(`Unknown question: ${answer.questionId}`);
    if (seen.has(question.id)) throw badRequest('Duplicate answer for the same question');
    seen.add(question.id);

    if (CHOICE_TYPES.includes(question.type)) {
      const ids = answer.optionIds ?? [];
      if (ids.length === 0) {
        if (question.required) throw badRequest(`Question "${question.prompt}" requires an answer`);
        continue;
      }
      if (question.type !== 'multi_choice' && question.type !== 'ranking' && ids.length > 1) {
        throw badRequest(`Question "${question.prompt}" accepts only one option`);
      }

      const valid = new Set((question.options ?? []).map((o) => o.id));

      if (question.type === 'ranking') {
        // A ranking is an ordering of every option, so the payload has to be a
        // permutation: no repeats, nothing missing. Anything else would make
        // the positions incomparable between respondents — a 3rd place out of
        // 5 does not mean the same thing as a 3rd out of 3.
        if (new Set(ids).size !== ids.length) {
          throw badRequest(`Question "${question.prompt}" lists an option more than once`);
        }
        if (ids.length !== valid.size) {
          throw badRequest(`Question "${question.prompt}" must rank every option`);
        }
        ids.forEach((optionId, index) => {
          if (!valid.has(optionId)) throw badRequest('Option does not belong to this question');
          // 1-based: "position 1" reads as first place in every report.
          rows.push({ questionId: question.id, optionId, rank: index + 1 });
        });
        continue;
      }

      for (const optionId of ids) {
        // Rejects an option id copied from a different poll entirely.
        if (!valid.has(optionId)) throw badRequest('Option does not belong to this question');
        rows.push({ questionId: question.id, optionId });
      }
      continue;
    }

    const value = answer.valueText ?? (answer.valueNum !== undefined ? String(answer.valueNum) : '');
    if (!value) {
      if (question.required) throw badRequest(`Question "${question.prompt}" requires an answer`);
      continue;
    }
    if (question.type === 'rating') {
      const n = Number(value);
      const max = Number(question.config?.max ?? 5);
      if (!Number.isFinite(n) || n < 1 || n > max) {
        throw badRequest(`Rating must be between 1 and ${max}`);
      }
    }
    rows.push({ questionId: question.id, valueText: value });
  }

  // A required question omitted entirely from the payload must still fail.
  for (const q of questions) {
    if (q.required && !seen.has(q.id)) throw badRequest(`Question "${q.prompt}" requires an answer`);
  }

  return rows;
}

export async function hasResponded(pollId, context) {
  return repo.hasResponded(pollId, {
    userId: context.userId,
    fingerprintHash: context.deviceId ? identityHash(context.deviceId) : null,
    ipHash: identityHash(context.clientIp),
  });
}
