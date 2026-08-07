import { pool } from './pool.js';

/**
 * Run `fn` inside a single transaction and hand it the client.
 *
 * Every repository function takes an optional client as its first argument so
 * the *caller* owns the transaction boundary. This is what lets the response
 * insert and the tally increment commit together — split across two pool
 * connections they would not be atomic, and a crash between them would leave
 * the tally disagreeing with the responses table.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Connection is already broken; releasing it is all we can do.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Postgres error codes we branch on. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
};
