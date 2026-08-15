import { env } from '../../config/env.js';
import { withTransaction, PG } from '../../db/transaction.js';
import * as repo from './polls.repository.js';
import { generateSlug } from '../../lib/slug.js';
import { imageUrl, shareCardUrl } from '../../integrations/cloudinary.js';
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
  return closed;
}

export async function archive(pollId, userId) {
  await getOwned(pollId, userId);
  const archived = await repo.setStatus(pollId, 'archived');
  evict(pollId);
  return archived;
}

/** Copy structure only — never responses or tallies. */
export async function duplicate(pollId, userId) {
  const poll = await getOwned(pollId, userId);
  const questions = await repo.questionsWithOptions(pollId);

  return createPoll(userId, {
    type: poll.type,
    title: `${poll.title} (copy)`,
    description: poll.description ?? undefined,
    visibility: poll.visibility,
    identityMode: poll.identity_mode,
    dedupMode: poll.dedup_mode,
    resultsMode: poll.results_mode,
    coverPublicId: poll.cover_public_id ?? undefined,
    questions: questions.map((q) => ({
      type: q.type,
      prompt: q.prompt,
      required: q.required,
      config: q.config,
      options: q.options.map((o) => ({ label: o.label ?? undefined })),
    })),
  });
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
