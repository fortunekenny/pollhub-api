import { query } from '../db/pool.js';

/**
 * Hot in-memory mirror of active poll tallies.
 *
 * Postgres stays authoritative — this only exists so a broadcast to 500
 * subscribers does not become 500 queries. It is rebuilt from the database on
 * first subscribe and can be dropped at any time without data loss.
 *
 * Cache shape: pollId -> Map(optionId -> count)
 */
const mirror = new Map();

export async function load(pollId) {
  const { rows } = await query(
    'SELECT option_id, count FROM tallies WHERE poll_id = $1',
    [pollId],
  );
  const counts = new Map(rows.map((r) => [r.option_id, Number(r.count)]));
  mirror.set(pollId, counts);
  return counts;
}

export async function snapshot(pollId) {
  const counts = mirror.get(pollId) ?? (await load(pollId));
  return Object.fromEntries(counts);
}

/**
 * Apply increments already committed to Postgres.
 *
 * Called after COMMIT, never inside the transaction: applying it early would
 * show a vote that a rollback then erased, and the mirror has no way to learn
 * it was wrong.
 */
export function applyDelta(pollId, optionIds) {
  const counts = mirror.get(pollId);
  if (!counts) return null; // nobody is watching; next load() picks it up

  const delta = {};
  for (const optionId of optionIds) {
    const next = (counts.get(optionId) ?? 0) + 1;
    counts.set(optionId, next);
    delta[optionId] = next;
  }
  return delta;
}

/** Drop a poll from the mirror — on close, or to reclaim memory. */
export function evict(pollId) {
  mirror.delete(pollId);
}

export function stats() {
  return { polls: mirror.size };
}
