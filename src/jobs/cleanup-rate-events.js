import { pool } from '../db/pool.js';

/**
 * Expire old rate-limit windows.
 *
 * rate_events grows one row per key per window forever otherwise, and on a
 * free-tier 200 GB volume "forever" eventually matters. Windows older than a
 * day cannot affect any live limit.
 */
export async function cleanupRateEvents() {
  const { rowCount } = await pool.query(
    "DELETE FROM rate_events WHERE window_start < now() - interval '1 day'",
  );
  return rowCount > 0 ? { deleted: rowCount } : null;
}
