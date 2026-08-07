import { pool } from '../../db/pool.js';

const db = (client) => client ?? pool;

/** Responses bucketed by hour — drives the "responses over time" chart. */
export async function responsesOverTime(pollId, client) {
  const { rows } = await db(client).query(
    `SELECT date_trunc('hour', submitted_at) AS bucket, count(*)::int AS n
       FROM responses
      WHERE poll_id = $1
      GROUP BY bucket
      ORDER BY bucket`,
    [pollId],
  );
  return rows.map((r) => ({ bucket: r.bucket, count: r.n }));
}

/**
 * Per-question answer counts.
 *
 * Drop-off is derived from this: a survey question answered by far fewer
 * respondents than the one before it is where people are quitting.
 */
export async function perQuestionCompletion(pollId, client) {
  const { rows } = await db(client).query(
    `SELECT q.id, q.position, q.prompt, q.type, q.required,
            count(DISTINCT a.response_id)::int AS answered
       FROM questions q
       LEFT JOIN answers a ON a.question_id = q.id
      WHERE q.poll_id = $1
      GROUP BY q.id
      ORDER BY q.position`,
    [pollId],
  );
  return rows;
}

export async function optionBreakdown(pollId, client) {
  const { rows } = await db(client).query(
    `SELECT q.id AS question_id, q.prompt, o.id AS option_id, o.label,
            COALESCE(t.count, 0)::int AS count
       FROM questions q
       JOIN options o  ON o.question_id = q.id
       LEFT JOIN tallies t ON t.option_id = o.id AND t.poll_id = q.poll_id
      WHERE q.poll_id = $1
      ORDER BY q.position, o.position`,
    [pollId],
  );
  return rows;
}

export async function textAnswers(pollId, questionId, client) {
  const { rows } = await db(client).query(
    `SELECT a.value_text, r.submitted_at
       FROM answers a
       JOIN responses r ON r.id = a.response_id
      WHERE r.poll_id = $1 AND a.question_id = $2 AND a.value_text IS NOT NULL
      ORDER BY r.submitted_at DESC
      LIMIT 500`,
    [pollId, questionId],
  );
  return rows;
}

export async function summary(pollId, client) {
  const { rows } = await db(client).query(
    `SELECT count(*)::int AS responses,
            count(respondent_user_id)::int AS identified,
            min(submitted_at) AS first_response,
            max(submitted_at) AS last_response
       FROM responses WHERE poll_id = $1`,
    [pollId],
  );
  return rows[0];
}
