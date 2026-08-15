-- Sessions that outlive a 15-minute access token.
--
-- REFRESH_TOKEN_TTL_DAYS has been in constants.js since the start with nothing
-- reading it: there was no refresh route, so a session simply ended after
-- fifteen minutes, mid-action, with no way back except signing in again.
--
-- Only the hash is stored, exactly as email_tokens does. A refresh token is a
-- bearer credential for a month of access, so the database must not hold
-- anything an attacker could replay if it leaked.
--
-- Rows are kept after revocation rather than deleted. A presented token that
-- is already revoked is the signal for reuse detection — either a stolen token
-- being replayed, or a client retrying a rotation it never saw the result of.
-- Deleting on revoke would make that case indistinguishable from a token that
-- never existed, and there would be nothing to detect.

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reuse detection revokes every live token for the user at once, which is the
-- only query that reads by user rather than by hash. Partial, because revoked
-- rows are kept forever and are never the target of that sweep.
CREATE INDEX refresh_tokens_user_idx
    ON refresh_tokens (user_id)
 WHERE revoked_at IS NULL;
