import { pool } from '../../db/pool.js';

const db = (client) => client ?? pool;

/**
 * Increment several option counters in one statement.
 *
 * A plain `count = count + 1` UPDATE, not a read-modify-write: two concurrent
 * votes for the same option each hold a row lock for the duration of their
 * own statement, and both increments land. Reading the count into JS first
 * and writing back would lose one of them.
 *
 * Must be called with the same client as the response insert so the two
 * commit or roll back together.
 */
export async function incrementMany(pollId, optionIds, client) {
  if (optionIds.length === 0) return [];
  const { rows } = await db(client).query(
    `UPDATE tallies
        SET count = count + 1
      WHERE poll_id = $1 AND option_id = ANY($2::uuid[])
  RETURNING option_id, count`,
    [pollId, optionIds],
  );
  return rows;
}

export async function forPoll(pollId, client) {
  const { rows } = await db(client).query(
    'SELECT option_id, count FROM tallies WHERE poll_id = $1',
    [pollId],
  );
  return rows;
}

/** Rebuild from responses — repair path if a tally ever drifts. */
export async function recomputeFromAnswers(pollId, client) {
  await db(client).query(
    `UPDATE tallies t
        SET count = COALESCE(sub.n, 0)
       FROM (
            SELECT a.option_id, count(*)::bigint AS n
              FROM answers a
              JOIN responses r ON r.id = a.response_id
             WHERE r.poll_id = $1 AND a.option_id IS NOT NULL
             GROUP BY a.option_id
       ) sub
      WHERE t.poll_id = $1 AND t.option_id = sub.option_id`,
    [pollId],
  );
}
