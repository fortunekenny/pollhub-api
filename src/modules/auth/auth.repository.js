import { pool } from '../../db/pool.js';

const db = (client) => client ?? pool;

export async function findByEmail(email, client) {
  const { rows } = await db(client).query(
    'SELECT * FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  return rows[0] ?? null;
}

export async function findById(id, client) {
  const { rows } = await db(client).query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function findByGoogleSub(sub, client) {
  const { rows } = await db(client).query('SELECT * FROM users WHERE google_sub = $1', [sub]);
  return rows[0] ?? null;
}

export async function createUser({ email, passwordHash, name, googleSub, verifiedAt }, client) {
  const { rows } = await db(client).query(
    `INSERT INTO users (email, password_hash, name, google_sub, verified_at)
          VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
    [email, passwordHash ?? null, name, googleSub ?? null, verifiedAt ?? null],
  );
  return rows[0];
}

export async function linkGoogle(userId, googleSub, client) {
  const { rows } = await db(client).query(
    `UPDATE users
        SET google_sub = $2,
            verified_at = COALESCE(verified_at, now())
      WHERE id = $1
  RETURNING *`,
    [userId, googleSub],
  );
  return rows[0];
}

export async function setPassword(userId, passwordHash, client) {
  await db(client).query('UPDATE users SET password_hash = $2 WHERE id = $1', [
    userId,
    passwordHash,
  ]);
}

export async function markVerified(userId, client) {
  await db(client).query(
    'UPDATE users SET verified_at = COALESCE(verified_at, now()) WHERE id = $1',
    [userId],
  );
}

export async function createRefreshToken({ userId, tokenHash, expiresAt }, client) {
  const { rows } = await db(client).query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
          VALUES ($1, $2, $3)
       RETURNING *`,
    [userId, tokenHash, expiresAt],
  );
  return rows[0];
}

/**
 * Claim a refresh token for rotation.
 *
 * The guards live inside the UPDATE for the same reason consumeEmailToken puts
 * them there: two tabs refreshing at once must not both succeed and both be
 * handed a new session. The loser updates zero rows and is treated as reuse.
 */
export async function claimRefreshToken(tokenHash, client) {
  const { rows } = await db(client).query(
    `UPDATE refresh_tokens
        SET revoked_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()
  RETURNING *`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function findRefreshToken(tokenHash, client) {
  const { rows } = await db(client).query(
    'SELECT * FROM refresh_tokens WHERE token_hash = $1',
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function revokeRefreshToken(tokenHash, client) {
  await db(client).query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash],
  );
}

/** Every live session for a user — sign-out-everywhere, and reuse response. */
export async function revokeAllRefreshTokens(userId, client) {
  const { rowCount } = await db(client).query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  return rowCount;
}

export async function createEmailToken({ userId, tokenHash, purpose, expiresAt }, client) {
  const { rows } = await db(client).query(
    `INSERT INTO email_tokens (user_id, token_hash, purpose, expires_at)
          VALUES ($1, $2, $3, $4)
       RETURNING *`,
    [userId, tokenHash, purpose, expiresAt],
  );
  return rows[0];
}

/**
 * Consume a token atomically.
 *
 * The `used_at IS NULL` guard is inside the UPDATE, so two concurrent
 * requests with the same reset link cannot both succeed — the second one
 * updates zero rows.
 */
export async function consumeEmailToken(tokenHash, purpose, client) {
  const { rows } = await db(client).query(
    `UPDATE email_tokens
        SET used_at = now()
      WHERE token_hash = $1
        AND purpose = $2
        AND used_at IS NULL
        AND expires_at > now()
  RETURNING *`,
    [tokenHash, purpose],
  );
  return rows[0] ?? null;
}
