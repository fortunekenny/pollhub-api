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
export async function incrementMany(pollId, entries, client) {
  if (entries.length === 0) return [];

  // Ranked answers also add their position to rank_sum, so a ranking's average
  // position stays a running total on the same row as its count rather than an
  // aggregate query per viewer. Non-ranking answers contribute 0 and leave
  // rank_sum untouched.
  const optionIds = entries.map((e) => e.optionId);
  const ranks = entries.map((e) => e.rank ?? 0);

  const { rows } = await db(client).query(
    `UPDATE tallies t
        SET count = t.count + 1,
            rank_sum = t.rank_sum + v.rank
       FROM UNNEST($2::uuid[], $3::int[]) AS v(option_id, rank)
      WHERE t.poll_id = $1 AND t.option_id = v.option_id
  RETURNING t.option_id, t.count, t.rank_sum`,
    [pollId, optionIds, ranks],
  );
  return rows;
}

export async function forPoll(pollId, client) {
  const { rows } = await db(client).query(
    'SELECT option_id, count, rank_sum FROM tallies WHERE poll_id = $1',
    [pollId],
  );
  return rows;
}

/** Rebuild from responses — repair path if a tally ever drifts. */
export async function recomputeFromAnswers(pollId, client) {
  await db(client).query(
    `UPDATE tallies t
        SET count = COALESCE(sub.n, 0),
            rank_sum = COALESCE(sub.rank_sum, 0)
       FROM (
            SELECT a.option_id,
                   count(*)::bigint AS n,
                   COALESCE(sum(a.rank), 0)::bigint AS rank_sum
              FROM answers a
              JOIN responses r ON r.id = a.response_id
             WHERE r.poll_id = $1 AND a.option_id IS NOT NULL
             GROUP BY a.option_id
       ) sub
      WHERE t.poll_id = $1 AND t.option_id = sub.option_id`,
    [pollId],
  );
}
