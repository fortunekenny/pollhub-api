import { env } from '../../config/env.js';
import { withTransaction, PG } from '../../db/transaction.js';
import { queryOne } from '../../db/pool.js';
import { notify, events } from '../notifications/notifications.service.js';
import { logger } from '../../lib/logger.js';
import * as repo from './polls.repository.js';
import { generateSlug } from '../../lib/slug.js';
import { imageUrl, shareCardUrl, destroyImage } from '../../integrations/cloudinary.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { evict } from '../../realtime/tally-mirror.js';
import { publishPollStatus } from '../../realtime/ws-server.js';

export async function createPoll(ownerId, input) {
  return withTransaction(async (client) => {
    const poll = await insertWithUniqueSlug(ownerId, input, client);

    for (const [qIndex, q] of input.questions.entries()) {
      const question = await repo.insertQuestion(
        {
          pollId: poll.id,
          position: qIndex,
          type: q.type,
          prompt: q.prompt,
          required: q.required,
          config: q.config,
        },
        client,
      );

      for (const [oIndex, o] of q.options.entries()) {
        const option = await repo.insertOption(
          {
            questionId: question.id,
            position: oIndex,
            label: o.label,
            imagePublicId: o.imagePublicId,
          },
          client,
        );
        // Seeded now so the vote path is a pure UPDATE — no upsert, no branch
        // on whether this is the first vote for an option.
        await repo.seedTally(poll.id, option.id, client);
      }
    }

    return poll;
  });
}

/**
 * Slug collisions are rare at 8 base58 characters but not impossible, and the
 * unique index is the only real arbiter. Retry rather than pre-checking.
 */
async function insertWithUniqueSlug(ownerId, input, client, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await repo.insertPoll({ ...input, ownerId, slug: generateSlug() }, client);
    } catch (err) {
      if (err.code !== PG.UNIQUE_VIOLATION) throw err;
    }
  }
  throw conflict('Could not allocate a unique poll link, please retry');
}

export async function getOwned(pollId, userId) {
  const poll = await repo.findById(pollId);
  if (!poll) throw notFound('Poll not found');
  if (poll.owner_id !== userId) throw forbidden('You do not own this poll');
  return poll;
}

export async function updateSettings(pollId, userId, patch) {
  const poll = await getOwned(pollId, userId);
  if (poll.status === 'archived') throw badRequest('Archived polls cannot be edited');

  // Structural integrity rule from the brief: once a response exists, the
  // rules that response was collected under are frozen. Changing dedup or
  // identity mode mid-poll would make the result impossible to interpret.
  if (poll.response_count > 0) {
    const locked = ['dedupMode', 'identityMode'].filter((k) => patch[k] !== undefined);
    if (locked.length > 0) {
      throw conflict(
        `Cannot change ${locked.join(' or ')} after the first response`,
        'locked_after_response',
      );
    }
  }

  return repo.updatePoll(pollId, patch, null);
}

export async function publish(pollId, userId) {
  const poll = await getOwned(pollId, userId);
  if (poll.status === 'published') return poll;
  if (poll.status !== 'draft') throw badRequest(`Cannot publish a ${poll.status} poll`);

  const questions = await repo.questionsWithOptions(pollId);
  if (questions.length === 0) throw badRequest('Add at least one question before publishing');

  return repo.setStatus(pollId, 'published');
}

export async function close(pollId, userId) {
  const poll = await getOwned(pollId, userId);
  if (poll.status !== 'published') throw badRequest(`Cannot close a ${poll.status} poll`);

  const closed = await repo.setStatus(pollId, 'closed');
  publishPollStatus(pollId, 'closed');
  evict(pollId); // nothing more will be tallied

  // The same event the scheduler raises when a deadline passes. A poll that
  // closed is a poll whose results are final, and that was worth telling the
  // owner about either way — closing by hand used to send nothing at all.
  //
  // No double-send risk: closeDuePolls only ever selects `published` rows, and
  // this one is already `closed` by the time that job could see it.
  void notifyResultsReady(closed);

  return closed;
}

/** Not awaited by callers: a notification must not delay or fail the close. */
async function notifyResultsReady(poll) {
  try {
    const owner = await queryOne('SELECT email FROM users WHERE id = $1', [poll.owner_id]);
    await notify({
      userId: poll.owner_id,
      ...events.resultsReady(poll),
      link: `/polls/${poll.id}`,
      data: { email: owner?.email, pollId: poll.id },
    });
  } catch (err) {
    logger.warn('close notify failed', { err: err.message, pollId: poll.id });
  }
}

export async function archive(pollId, userId) {
  await getOwned(pollId, userId);
  const archived = await repo.setStatus(pollId, 'archived');
  evict(pollId);
  return archived;
}

/**
 * Permanently delete a poll and everything under it.
 *
 * Which statuses allow this differs by role, because the risk does. An owner
 * may only delete what is already archived — a state they had to choose
 * deliberately, and which already hides the poll — so the destructive step is
 * never one click away from a poll people can still see. An admin may also
 * delete a closed poll, since moderation sometimes has to remove something
 * without waiting for its owner to archive it.
 *
 * A draft is not deletable by either. That is a deliberate reading of the
 * rule rather than an oversight: archive it first, which costs one click and
 * keeps a single path to deletion instead of two.
 *
 * The rows go via ON DELETE CASCADE — responses, answers, tallies, invite
 * codes and reports all follow the poll. Images are cleaned up afterwards and
 * best-effort: an orphaned Cloudinary asset is a smaller problem than a poll
 * that refuses to delete because an unrelated service is down.
 */
const DELETABLE_STATUSES = { admin: ['closed', 'archived'], creator: ['archived'] };

export async function remove(pollId, user) {
  const poll = await repo.findById(pollId);
  if (!poll) throw notFound('Poll not found');

  const isAdmin = user.role === 'admin';
  if (!isAdmin && poll.owner_id !== user.id) throw forbidden('You do not own this poll');

  const allowed = DELETABLE_STATUSES[isAdmin ? 'admin' : 'creator'];
  if (!allowed.includes(poll.status)) {
    throw conflict(
      isAdmin
        ? 'Only closed or archived polls can be deleted'
        : 'Only archived polls can be deleted — archive it first',
      'not_deletable',
    );
  }

  // Read the image ids before the rows go, or there is nothing left to clean.
  const questions = await repo.questionsWithOptions(pollId);
  const publicIds = [
    poll.cover_public_id,
    ...questions.flatMap((q) => (q.options ?? []).map((o) => o.imagePublicId)),
  ].filter(Boolean);

  await repo.deletePoll(pollId);
  evict(pollId);

  for (const publicId of publicIds) await destroyImage(publicId);

  return { id: pollId, imagesRemoved: publicIds.length };
}

export function shareLinks(poll) {
  return {
    url: `${env.PUBLIC_POLL_BASE_URL}/${poll.slug}`,
    qrSvg: `${env.API_PUBLIC_URL}/api/v1/polls/${poll.id}/qr.svg`,
    shareCard: shareCardUrl(poll.cover_public_id, poll.title),
  };
}

/** Whether results may be shown to this viewer right now. */
export function canSeeResults(poll, { isOwner, hasResponded }) {
  if (isOwner) return true;
  switch (poll.results_mode) {
    case 'live':
      return true;
    case 'after_vote':
      return Boolean(hasResponded);
    case 'after_close':
      return poll.status === 'closed';
    case 'creator_only':
    default:
      return false;
  }
}

export function presentPoll(poll, { includeOwnerFields = false } = {}) {
  return {
    id: poll.id,
    type: poll.type,
    title: poll.title,
    description: poll.description,
    slug: poll.slug,
    status: poll.status,
    visibility: poll.visibility,
    identityMode: poll.identity_mode,
    dedupMode: poll.dedup_mode,
    resultsMode: poll.results_mode,
    coverUrl: imageUrl(poll.cover_public_id, { width: 1200 }),
    opensAt: poll.opens_at,
    closesAt: poll.closes_at,
    responseCount: poll.response_count,
    createdAt: poll.created_at,
    ...(includeOwnerFields ? { ownerId: poll.owner_id, share: shareLinks(poll) } : {}),
  };
}

export function presentQuestions(questions, { withCounts }) {
  return questions.map((q) => ({
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    required: q.required,
    config: q.config,
    options: (q.options ?? []).map((o) => ({
      id: o.id,
      label: o.label,
      imageUrl: imageUrl(o.imagePublicId, { width: 600 }),
      // rankSum rides along with count: for a ranking question the client
      // divides the two to get the average position. Withheld for the same
      // reason count is when results are not yet visible — the sum of
      // positions leaks the standings just as plainly as the tally does.
      ...(withCounts ? { count: o.count ?? 0, rankSum: o.rankSum ?? 0 } : {}),
    })),
  }));
}
