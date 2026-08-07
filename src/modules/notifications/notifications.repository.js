import { pool } from '../../db/pool.js';

const db = (client) => client ?? pool;

export async function registerToken({ userId, token, provider, platform }, client) {
  const { rows } = await db(client).query(
    `INSERT INTO push_tokens (user_id, token, provider, platform)
          VALUES ($1,$2,$3,$4)
     ON CONFLICT (token) DO UPDATE
            SET user_id = EXCLUDED.user_id,
                last_seen_at = now(),
                revoked_at = NULL
       RETURNING *`,
    [userId, token, provider, platform],
  );
  return rows[0];
}

export async function revokeToken(token, client) {
  await db(client).query(
    'UPDATE push_tokens SET revoked_at = now() WHERE token = $1',
    [token],
  );
}

/** Bulk revoke for tokens the provider reported as dead. */
export async function revokeMany(tokens, client) {
  if (tokens.length === 0) return;
  await db(client).query(
    'UPDATE push_tokens SET revoked_at = now() WHERE token = ANY($1::text[])',
    [tokens],
  );
}

export async function activeTokens(userId, client) {
  const { rows } = await db(client).query(
    `SELECT token, provider, platform FROM push_tokens
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return rows;
}

/** Preferences default to on — absent row means opted in. */
export async function prefsFor(userId, eventType, client) {
  const { rows } = await db(client).query(
    `SELECT email, push_mobile, push_web FROM notification_prefs
      WHERE user_id = $1 AND event_type = $2`,
    [userId, eventType],
  );
  return rows[0] ?? { email: true, push_mobile: true, push_web: true };
}

export async function setPrefs(userId, eventType, prefs, client) {
  const { rows } = await db(client).query(
    `INSERT INTO notification_prefs (user_id, event_type, email, push_mobile, push_web)
          VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, event_type) DO UPDATE
            SET email = EXCLUDED.email,
                push_mobile = EXCLUDED.push_mobile,
                push_web = EXCLUDED.push_web
       RETURNING *`,
    [userId, eventType, prefs.email, prefs.pushMobile, prefs.pushWeb],
  );
  return rows[0];
}

export async function allPrefs(userId, client) {
  const { rows } = await db(client).query(
    'SELECT event_type, email, push_mobile, push_web FROM notification_prefs WHERE user_id = $1',
    [userId],
  );
  return rows;
}
