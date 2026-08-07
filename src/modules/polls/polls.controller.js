import * as service from './polls.service.js';
import * as repo from './polls.repository.js';
import { qrSvg } from '../../lib/qr.js';
import { gone, notFound } from '../../lib/errors.js';

export async function create(req, res) {
  const poll = await service.createPoll(req.user.id, req.body);
  res.status(201).json({ poll: service.presentPoll(poll, { includeOwnerFields: true }) });
}

export async function list(req, res) {
  const { status, limit, offset } = req.validatedQuery;
  const polls = await repo.listByOwner({ ownerId: req.user.id, status, limit, offset });
  res.json({ polls: polls.map((p) => service.presentPoll(p, { includeOwnerFields: true })) });
}

export async function listPublic(req, res) {
  const { limit, offset } = req.validatedQuery;
  const polls = await repo.listPublic({ limit, offset });
  res.json({ polls: polls.map((p) => service.presentPoll(p)) });
}

export async function getOne(req, res) {
  const poll = await service.getOwned(req.validatedParams.id, req.user.id);
  const questions = await repo.questionsWithOptions(poll.id);
  res.json({
    poll: service.presentPoll(poll, { includeOwnerFields: true }),
    questions: service.presentQuestions(questions, { withCounts: false }),
  });
}

/**
 * Public respondent view, by slug.
 *
 * Counts are stripped unless this viewer is allowed to see results — the
 * check happens here rather than in the query so there is exactly one place
 * that decides visibility.
 */
export async function getBySlug(req, res) {
  const poll = await repo.findFullBySlug(req.validatedParams.slug);
  if (!poll) throw notFound('Poll not found');

  if (poll.status === 'draft') throw notFound('Poll not found');
  if (poll.status === 'archived') throw gone('This poll has been archived');

  const isOwner = req.user?.id === poll.owner_id;
  const showResults = service.canSeeResults(poll, { isOwner, hasResponded: false });

  const now = Date.now();
  const notYetOpen = poll.opens_at && new Date(poll.opens_at).getTime() > now;
  const isClosed =
    poll.status === 'closed' || (poll.closes_at && new Date(poll.closes_at).getTime() <= now);

  res.json({
    poll: service.presentPoll(poll, { includeOwnerFields: isOwner }),
    questions: service.presentQuestions(poll.questions, { withCounts: showResults }),
    state: { notYetOpen, isClosed, acceptingResponses: !notYetOpen && !isClosed },
    resultsVisible: showResults,
  });
}

export async function update(req, res) {
  const poll = await service.updateSettings(req.validatedParams.id, req.user.id, req.body);
  res.json({ poll: service.presentPoll(poll, { includeOwnerFields: true }) });
}

export async function publish(req, res) {
  const poll = await service.publish(req.validatedParams.id, req.user.id);
  res.json({ poll: service.presentPoll(poll, { includeOwnerFields: true }) });
}

export async function close(req, res) {
  const poll = await service.close(req.validatedParams.id, req.user.id);
  res.json({ poll: service.presentPoll(poll, { includeOwnerFields: true }) });
}

export async function archive(req, res) {
  const poll = await service.archive(req.validatedParams.id, req.user.id);
  res.json({ poll: service.presentPoll(poll, { includeOwnerFields: true }) });
}

export async function duplicate(req, res) {
  const poll = await service.duplicate(req.validatedParams.id, req.user.id);
  res.status(201).json({ poll: service.presentPoll(poll, { includeOwnerFields: true }) });
}

export async function qr(req, res) {
  const poll = await repo.findById(req.validatedParams.id);
  if (!poll) throw notFound('Poll not found');

  const svg = await qrSvg(service.shareLinks(poll).url);
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
}
