import { pool } from '../../db/pool.js';
import { identityHash } from '../../lib/hash.js';

const db = (client) => client ?? pool;

export async function insertCodes(pollId, codes, client) {
  const values = [];
  const params = [pollId];
  codes.forEach((c, i) => {
    params.push(identityHash(c.code), c.email ?? null);
    values.push(`($1, $${params.length - 1}, $${params.length})`);
  });

  const { rows } = await db(client).query(
    `INSERT INTO invite_codes (poll_id, code_hash, email)
     VALUES ${values.join(', ')}
     ON CONFLICT (poll_id, code_hash) DO NOTHING
     RETURNING id, email`,
    params,
  );
  return rows;
}

/**
 * Claim a code atomically.
 *
 * `used_at IS NULL` lives inside the UPDATE so two people racing with the
 * same code cannot both be admitted — the loser updates zero rows. A SELECT
 * then UPDATE would let both through.
 */
export async function claimCode(pollId, code, client) {
  if (!code) return null;
  const { rows } = await db(client).query(
    `UPDATE invite_codes
        SET used_at = now()
      WHERE poll_id = $1 AND code_hash = $2 AND used_at IS NULL
  RETURNING id`,
    [pollId, identityHash(code)],
  );
  return rows[0]?.id ?? null;
}

export async function listForPoll(pollId, client) {
  const { rows } = await db(client).query(
    `SELECT id, email, used_at, created_at
       FROM invite_codes WHERE poll_id = $1 ORDER BY created_at`,
    [pollId],
  );
  return rows;
}

export async function stats(pollId, client) {
  const { rows } = await db(client).query(
    `SELECT count(*)::int AS issued,
            count(used_at)::int AS used
       FROM invite_codes WHERE poll_id = $1`,
    [pollId],
  );
  return rows[0];
}
