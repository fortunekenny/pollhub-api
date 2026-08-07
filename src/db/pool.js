import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

// Return BIGINT/COUNT as Number instead of string. Tallies never approach
// Number.MAX_SAFE_INTEGER, and string counts break arithmetic silently.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // An idle client erroring out must not take the process down.
  logger.error('idle postgres client error', { err: err.message });
});

/** Run a query on the shared pool. */
export function query(text, params) {
  return pool.query(text, params);
}

/** First row or null. */
export async function queryOne(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] ?? null;
}

export async function closePool() {
  await pool.end();
}
