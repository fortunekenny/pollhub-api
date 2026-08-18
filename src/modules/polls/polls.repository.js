import { pool } from '../../db/pool.js';

const db = (client) => client ?? pool;

export async function insertPoll(poll, client) {
  const { rows } = await db(client).query(
    `INSERT INTO polls (owner_id, type, title, description, slug, visibility,
                        identity_mode, dedup_mode, results_mode, cover_public_id,
                        opens_at, closes_at, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft')
       RETURNING *`,
    [
      poll.ownerId, poll.type, poll.title, poll.description ?? null, poll.slug,
      poll.visibility, poll.identityMode, poll.dedupMode, poll.resultsMode,
      poll.coverPublicId ?? null, poll.opensAt ?? null, poll.closesAt ?? null,
    ],
  );
  return rows[0];
}

export async function insertQuestion(q, client) {
  const { rows } = await db(client).query(
    `INSERT INTO questions (poll_id, position, type, prompt, required, config)
          VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
    [q.pollId, q.position, q.type, q.prompt, q.required, q.config],
  );
  return rows[0];
}

export async function insertOption(o, client) {
  const { rows } = await db(client).query(
    `INSERT INTO options (question_id, position, label, image_public_id)
          VALUES ($1,$2,$3,$4)
       RETURNING *`,
    [o.questionId, o.position, o.label ?? null, o.imagePublicId ?? null],
  );
  return rows[0];
}

/** Seed a zero row per option so the vote path only ever does UPDATE. */
export async function seedTally(pollId, optionId, client) {
  await db(client).query(
    `INSERT INTO tallies (poll_id, option_id, count) VALUES ($1,$2,0)
     ON CONFLICT (poll_id, option_id) DO NOTHING`,
    [pollId, optionId],
  );
}

export async function findById(id, client) {
  const { rows } = await db(client).query('SELECT * FROM polls WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function findBySlug(slug, client) {
  const { rows } = await db(client).query('SELECT * FROM polls WHERE slug = $1', [slug]);
  return rows[0] ?? null;
}

/** Poll with its questions, options and current counts, in one round trip. */
export async function findFullBySlug(slug, client) {
  const { rows } = await db(client).query(
    `SELECT p.*,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', q.id, 'position', q.position, 'type', q.type,
                  'prompt', q.prompt, 'required', q.required, 'config', q.config,
                  'options', COALESCE(o.options, '[]'::json)
                ) ORDER BY q.position
              ) FILTER (WHERE q.id IS NOT NULL), '[]'::json
            ) AS questions
       FROM polls p
       LEFT JOIN questions q ON q.poll_id = p.id
       LEFT JOIN LATERAL (
            SELECT json_agg(
                     json_build_object(
                       'id', op.id, 'position', op.position,
                       'label', op.label, 'imagePublicId', op.image_public_id,
                       'count', COALESCE(t.count, 0),
                       -- Sum of positions for ranking questions; average
                       -- position is rankSum/count. 0 for every other type.
                       'rankSum', COALESCE(t.rank_sum, 0)
                     ) ORDER BY op.position
                   ) AS options
              FROM options op
              LEFT JOIN tallies t ON t.option_id = op.id AND t.poll_id = p.id
             WHERE op.question_id = q.id
       ) o ON true
      WHERE p.slug = $1
      GROUP BY p.id`,
    [slug],
  );
  return rows[0] ?? null;
}

/**
 * Resolve a respondent link, which may name a round or a whole series.
 *
 * An exact slug always wins, so a link to a specific round keeps pointing at
 * that round and its results. Only when nothing matches exactly is the value
 * treated as a series slug, and then the round chosen is the one a respondent
 * would expect: the open one, else the next to open, else the most recent.
 */
export async function resolveRespondentSlug(slug, client) {
  const exact = await findFullBySlug(slug, client);
  if (exact) return exact;

  const { rows } = await db(client).query(
    `SELECT slug FROM polls
      WHERE series_slug = $1
        AND status <> 'archived'
      ORDER BY
        -- open now
        (status = 'published'
           AND (opens_at IS NULL OR opens_at <= now())
           AND (closes_at IS NULL OR closes_at > now())) DESC,
        -- else the one waiting to open, soonest first
        (status = 'published' AND opens_at > now()) DESC,
        round DESC
      LIMIT 1`,
    [slug],
  );
  return rows[0] ? findFullBySlug(rows[0].slug, client) : null;
}

/** Is this slug already taken as either a round slug or a series slug? */
export async function slugTaken(slug, client) {
  const { rows } = await db(client).query(
    'SELECT 1 FROM polls WHERE slug = $1 OR series_slug = $1 LIMIT 1',
    [slug],
  );
  return rows.length > 0;
}

export async function startSeries({ pollId, seriesSlug }, client) {
  const { rows } = await db(client).query(
    `UPDATE polls
        SET series_id = id, series_slug = $2, round = 1
      WHERE id = $1
  RETURNING *`,
    [pollId, seriesSlug],
  );
  return rows[0];
}

export async function joinSeries({ pollId, seriesId, seriesSlug, round, repeatInterval }, client) {
  const { rows } = await db(client).query(
    `UPDATE polls
        SET series_id = $2, series_slug = $3, round = $4, repeat_interval = $5
      WHERE id = $1
  RETURNING *`,
    [pollId, seriesId, seriesSlug, round, repeatInterval],
  );
  return rows[0];
}

export async function setRepeatInterval(id, interval, client) {
  const { rows } = await db(client).query(
    'UPDATE polls SET repeat_interval = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [id, interval],
  );
  return rows[0];
}

/**
 * Every round of a series, with its per-option tallies, as flat rows.
 *
 * Joined on position rather than option id, because each round is a fresh copy
 * with fresh ids — the third option of the second question is the same choice
 * in every round, and its id is not. Labels would read better as a key but the
 * owner can edit one round's wording without meaning to break the series.
 */
export async function seriesRounds(seriesId, client) {
  const { rows } = await db(client).query(
    `SELECT p.id           AS poll_id,
            p.round,
            p.status,
            p.opens_at,
            p.closes_at,
            p.response_count,
            q.position     AS question_position,
            q.prompt       AS question_prompt,
            q.type         AS question_type,
            op.position    AS option_position,
            op.label       AS option_label,
            COALESCE(t.count, 0) AS count
       FROM polls p
       LEFT JOIN questions q ON q.poll_id = p.id
       LEFT JOIN options op  ON op.question_id = q.id
       LEFT JOIN tallies t   ON t.option_id = op.id AND t.poll_id = p.id
      WHERE p.series_id = $1
      ORDER BY p.round, q.position, op.position`,
    [seriesId],
  );
  return rows;
}

export async function latestRound(seriesId, client) {
  const { rows } = await db(client).query(
    'SELECT * FROM polls WHERE series_id = $1 ORDER BY round DESC LIMIT 1',
    [seriesId],
  );
  return rows[0] ?? null;
}

export async function listByOwner({ ownerId, status, limit, offset }, client) {
  const { rows } = await db(client).query(
    `SELECT id, type, title, slug, visibility, status, results_mode,
            response_count, opens_at, closes_at, created_at
       FROM polls
      WHERE owner_id = $1
        AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4`,
    [ownerId, status ?? null, limit, offset],
  );
  return rows;
}

export async function listPublic({ limit, offset }, client) {
  const { rows } = await db(client).query(
    // closes_at rides along so the listing can count down rather than showing
    // a deadline that was accurate when the page loaded.
    `SELECT id, type, title, slug, response_count, created_at, closes_at, status,
            opens_at, published_at
       FROM polls
      WHERE visibility = 'public' AND status = 'published'
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}

export async function updatePoll(id, patch, client) {
  const map = {
    title: 'title',
    description: 'description',
    visibility: 'visibility',
    identityMode: 'identity_mode',
    dedupMode: 'dedup_mode',
    resultsMode: 'results_mode',
    coverPublicId: 'cover_public_id',
    opensAt: 'opens_at',
    closesAt: 'closes_at',
  };

  const sets = [];
  const values = [id];
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    values.push(patch[key]);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length === 0) return findById(id, client);

  // A moved deadline is a new deadline: clear the closing-warning marker so
  // the owner is warned about the time the poll now actually closes. Without
  // this, extending a poll that was already warned about silently costs it
  // its warning.
  if (patch.closesAt !== undefined) sets.push('closing_notified_at = NULL');

  const { rows } = await db(client).query(
    `UPDATE polls SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    values,
  );
  return rows[0];
}

export async function setStatus(id, status, client) {
  const { rows } = await db(client).query(
    `UPDATE polls
        SET status = $2,
            published_at = CASE WHEN $2 = 'published' THEN COALESCE(published_at, now())
                                ELSE published_at END,
            updated_at = now()
      WHERE id = $1
  RETURNING *`,
    [id, status],
  );
  return rows[0];
}

export async function countResponses(pollId, client) {
  const { rows } = await db(client).query(
    'SELECT count(*)::int AS n FROM responses WHERE poll_id = $1',
    [pollId],
  );
  return rows[0].n;
}

export async function questionsWithOptions(pollId, client) {
  const { rows } = await db(client).query(
    `SELECT q.id, q.position, q.type, q.prompt, q.required, q.config,
            COALESCE(json_agg(
              json_build_object('id', o.id, 'label', o.label, 'position', o.position)
              ORDER BY o.position
            ) FILTER (WHERE o.id IS NOT NULL), '[]'::json) AS options
       FROM questions q
       LEFT JOIN options o ON o.question_id = q.id
      WHERE q.poll_id = $1
      GROUP BY q.id
      ORDER BY q.position`,
    [pollId],
  );
  return rows;
}

/**
 * Delete a poll outright.
 *
 * No cascade is written here because the schema already declares it: every
 * child table references polls with ON DELETE CASCADE, so questions, options,
 * responses, answers, tallies, invite codes and reports go with it in one
 * statement.
 */
export async function deletePoll(id, client) {
  const { rowCount } = await db(client).query('DELETE FROM polls WHERE id = $1', [id]);
  return rowCount;
}

/** Polls whose close time has passed but which are still open. */
export async function dueForClose(client) {
  const { rows } = await db(client).query(
    `SELECT id FROM polls
      WHERE status = 'published' AND closes_at IS NOT NULL AND closes_at <= now()`,
  );
  return rows;
}
