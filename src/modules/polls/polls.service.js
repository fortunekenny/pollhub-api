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

// ------------------------------------------------------------- repeating ----

const INTERVAL_MS = {
  daily: 86_400_000,
  weekly: 7 * 86_400_000,
};

/** Months are not a fixed number of milliseconds, so step the calendar. */
function addInterval(date, interval) {
  if (interval === 'monthly') {
    const next = new Date(date);
    next.setMonth(next.getMonth() + 1);
    return next;
  }
  return new Date(date.getTime() + INTERVAL_MS[interval]);
}

/**
 * Give a poll the stable link its future rounds will share.
 *
 * Retried on collision for the same reason slug allocation is: the series slug
 * must not match any existing round slug or series slug, or a respondent link
 * becomes ambiguous.
 */
export async function ensureSeries(poll) {
  if (poll.series_id) return poll;

  for (let i = 0; i < 5; i += 1) {
    const candidate = generateSlug();
    if (await repo.slugTaken(candidate)) continue;
    return repo.startSeries({ pollId: poll.id, seriesSlug: candidate });
  }
  throw conflict('Could not allocate a series link, please retry');
}

/**
 * Open the next round of a repeating poll.
 *
 * The new round inherits the previous round's schedule shape rather than
 * simply starting now: its opening is one interval after the last opening, and
 * it stays open for however long the last round did. That is what makes "open
 * for a day, every week" expressible — anchoring to `now` instead would let
 * the series drift a little further from its slot on every roll.
 *
 * Questions and settings are copied; responses and tallies never are. The
 * round is published immediately so the series link keeps resolving to
 * something, even when the opening time is still ahead.
 */
export async function rollSeries(closedPoll) {
  if (!closedPoll.repeat_interval || !closedPoll.series_id) return null;

  const questions = await repo.questionsWithOptions(closedPoll.id);

  const prevOpen = new Date(
    closedPoll.opens_at ?? closedPoll.published_at ?? closedPoll.created_at,
  );
  const prevClose = closedPoll.closes_at ? new Date(closedPoll.closes_at) : null;
  const durationMs = prevClose ? prevClose.getTime() - prevOpen.getTime() : null;

  let opensAt = addInterval(prevOpen, closedPoll.repeat_interval);
  // A series left closed for a while would otherwise open its next round in
  // the past and be closed again on the very next tick. Walk forward instead.
  while (opensAt.getTime() + (durationMs ?? 0) <= Date.now()) {
    opensAt = addInterval(opensAt, closedPoll.repeat_interval);
  }

  const created = await createPoll(closedPoll.owner_id, {
    type: closedPoll.type,
    title: closedPoll.title,
    description: closedPoll.description ?? undefined,
    visibility: closedPoll.visibility,
    identityMode: closedPoll.identity_mode,
    dedupMode: closedPoll.dedup_mode,
    resultsMode: closedPoll.results_mode,
    coverPublicId: closedPoll.cover_public_id ?? undefined,
    opensAt,
    closesAt: durationMs ? new Date(opensAt.getTime() + durationMs) : null,
    questions: questions.map((q) => ({
      type: q.type,
      prompt: q.prompt,
      required: q.required,
      config: q.config,
      options: (q.options ?? []).map((o) => ({
        label: o.label ?? undefined,
        imagePublicId: o.imagePublicId ?? undefined,
      })),
    })),
  });

  const next = await repo.joinSeries({
    pollId: created.id,
    seriesId: closedPoll.series_id,
    seriesSlug: closedPoll.series_slug,
    round: closedPoll.round + 1,
    repeatInterval: closedPoll.repeat_interval,
  });

  return repo.setStatus(next.id, 'published');
}

/**
 * How a repeating poll has moved across its rounds.
 *
 * Rounds carry their own results already; what no single round can answer is
 * whether the answer is changing. So this is shaped for comparison: one row
 * per option, one column per round, and the rounds ordered oldest first so a
 * trend reads left to right.
 *
 * Only rounds that have closed, plus the one currently running, are worth
 * plotting — a round that has not opened has nothing to say and would render
 * as a misleading zero.
 */
export async function seriesReport(poll) {
  if (!poll.series_id) throw badRequest('This poll does not repeat');

  const rows = await repo.seriesRounds(poll.series_id);

  const rounds = [];
  const seenRounds = new Set();
  const questions = new Map();

  for (const r of rows) {
    if (!seenRounds.has(r.round)) {
      seenRounds.add(r.round);
      rounds.push({
        pollId: r.poll_id,
        round: r.round,
        status: r.status,
        opensAt: r.opens_at,
        closesAt: r.closes_at,
        responseCount: r.response_count,
      });
    }

    if (r.question_position === null || r.option_position === null) continue;

    if (!questions.has(r.question_position)) {
      questions.set(r.question_position, {
        position: r.question_position,
        prompt: r.question_prompt,
        type: r.question_type,
        options: new Map(),
      });
    }
    const q = questions.get(r.question_position);

    if (!q.options.has(r.option_position)) {
      q.options.set(r.option_position, {
        position: r.option_position,
        label: r.option_label,
        counts: {},
      });
    }
    // Later rounds win the label, so a corrected wording is what shows.
    const opt = q.options.get(r.option_position);
    if (r.option_label) opt.label = r.option_label;
    opt.counts[r.round] = Number(r.count);
  }

  // Split before summarising, or the totals describe a different set of rounds
  // than the table does — and "average per round" divides by rounds nobody can
  // see yet.
  const now = Date.now();
  const started = rounds.filter((r) => !r.opensAt || new Date(r.opensAt).getTime() <= now);
  const upcoming = rounds.length - started.length;

  return {
    series: {
      slug: poll.series_slug,
      repeatInterval: poll.repeat_interval,
      rounds: started.length,
      upcoming,
      totalResponses: started.reduce((n, r) => n + r.responseCount, 0),
    },
    rounds: started,
    questions: [...questions.values()].map((q) => ({
      position: q.position,
      prompt: q.prompt,
      type: q.type,
      options: [...q.options.values()],
    })),
  };
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

  // Closing a round early still advances the series — that is what repeating
  // means. To stop it, set the poll not to repeat before closing, or archive.
  if (closed.repeat_interval) {
    rollSeries(closed).catch((err) =>
      logger.error('series roll failed', { err: err.message, pollId: closed.id }),
    );
  }

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
 * A draft is deletable by both. It was never published, so there is nothing
 * to lose and nobody to surprise — making its owner archive it first would be
 * ceremony over an empty poll.
 *
 * The rows go via ON DELETE CASCADE — responses, answers, tallies, invite
 * codes and reports all follow the poll. Images are cleaned up afterwards and
 * best-effort: an orphaned Cloudinary asset is a smaller problem than a poll
 * that refuses to delete because an unrelated service is down.
 */
const DELETABLE_STATUSES = {
  admin: ['draft', 'closed', 'archived'],
  creator: ['draft', 'archived'],
};

export async function remove(pollId, user) {
  const poll = await repo.findById(pollId);
  if (!poll) throw notFound('Poll not found');

  const isAdmin = user.role === 'admin';
  if (!isAdmin && poll.owner_id !== user.id) throw forbidden('You do not own this poll');

  const allowed = DELETABLE_STATUSES[isAdmin ? 'admin' : 'creator'];
  if (!allowed.includes(poll.status)) {
    throw conflict(
      isAdmin
        ? 'Only draft, closed or archived polls can be deleted'
        : 'A published poll must be closed and archived before it can be deleted',
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
    // A repeating poll shares its series link, which follows the rounds. The
    // round's own slug still works and still shows that round's results — it
    // is just not the one to hand out.
    url: `${env.PUBLIC_POLL_BASE_URL}/${poll.series_slug ?? poll.slug}`,
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
    // When it actually started taking responses. A poll with no closing time
    // has no countdown to show, so the client counts up from here instead.
    publishedAt: poll.published_at ?? null,
    // Stands in for a close time on a poll shut by hand, which has no
    // closes_at to report. setStatus stamps updated_at, so for a closed poll
    // this is when it closed — until something edits it again.
    updatedAt: poll.updated_at ?? null,
    repeatInterval: poll.repeat_interval ?? null,
    // Only meaningful for a repeating poll; round 1 of a one-off says nothing.
    round: poll.series_id ? poll.round : null,
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
