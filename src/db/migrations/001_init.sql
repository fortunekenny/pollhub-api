-- PollHub initial schema.
-- Postgres is the single source of truth: dedup, tallies and rate limits all
-- live here. There is no Redis by design.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- users -----
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Plain TEXT plus a lower() unique index, so no citext extension is needed.
  email             TEXT NOT NULL,
  password_hash     TEXT,
  name              TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'creator'
                      CHECK (role IN ('creator', 'admin')),
  avatar_public_id  TEXT,
  google_sub        TEXT UNIQUE,
  verified_at       TIMESTAMPTZ,
  suspended_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE email_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX email_tokens_user_idx ON email_tokens (user_id, purpose);

-- ---------------------------------------------------------------- polls -----
CREATE TABLE polls (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              TEXT NOT NULL CHECK (type IN ('vote', 'survey')),
  title             TEXT NOT NULL,
  description       TEXT,
  slug              TEXT NOT NULL UNIQUE,
  visibility        TEXT NOT NULL DEFAULT 'unlisted'
                      CHECK (visibility IN ('public', 'unlisted', 'private')),
  identity_mode     TEXT NOT NULL DEFAULT 'anonymous'
                      CHECK (identity_mode IN ('anonymous', 'name_required', 'account_required')),
  dedup_mode        TEXT NOT NULL DEFAULT 'cookie_device'
                      CHECK (dedup_mode IN ('none', 'cookie_device', 'ip', 'account', 'invite_code')),
  results_mode      TEXT NOT NULL DEFAULT 'after_vote'
                      CHECK (results_mode IN ('live', 'after_vote', 'after_close', 'creator_only')),
  cover_public_id   TEXT,
  opens_at          TIMESTAMPTZ,
  closes_at         TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'published', 'closed', 'archived')),
  response_count    INTEGER NOT NULL DEFAULT 0,
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT polls_schedule_order CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);

CREATE INDEX polls_owner_idx  ON polls (owner_id, created_at DESC);
CREATE INDEX polls_public_idx ON polls (created_at DESC)
  WHERE visibility = 'public' AND status = 'published';
-- Drives the open/close scheduler without a full scan.
CREATE INDEX polls_schedule_idx ON polls (closes_at)
  WHERE status = 'published' AND closes_at IS NOT NULL;

CREATE TABLE questions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id    UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  type       TEXT NOT NULL CHECK (type IN (
               'single_choice', 'multi_choice', 'rating',
               'yes_no', 'short_text', 'long_text', 'ranking')),
  prompt     TEXT NOT NULL,
  required   BOOLEAN NOT NULL DEFAULT true,
  config     JSONB NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (poll_id, position)
);

CREATE TABLE options (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id      UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  label            TEXT,
  image_public_id  TEXT,

  UNIQUE (question_id, position),
  -- An option needs something to render: text, an image, or both.
  CONSTRAINT options_needs_content CHECK (label IS NOT NULL OR image_public_id IS NOT NULL)
);

-- ------------------------------------------------------------ responses -----
CREATE TABLE responses (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id              UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  respondent_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  respondent_name      TEXT,
  fingerprint_hash     TEXT,
  ip_hash              TEXT,
  invite_code_id       UUID,
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta                 JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Deduplication is enforced here, not in application code. A duplicate insert
-- fails atomically inside the vote transaction; there is no check-then-write
-- window for a racing second request to slip through.
-- Each index is partial so it only binds on polls using that dedup mode.
CREATE UNIQUE INDEX responses_dedup_fingerprint
  ON responses (poll_id, fingerprint_hash)
  WHERE fingerprint_hash IS NOT NULL;

CREATE UNIQUE INDEX responses_dedup_ip
  ON responses (poll_id, ip_hash)
  WHERE ip_hash IS NOT NULL;

CREATE UNIQUE INDEX responses_dedup_account
  ON responses (poll_id, respondent_user_id)
  WHERE respondent_user_id IS NOT NULL;

CREATE INDEX responses_poll_time_idx ON responses (poll_id, submitted_at);

CREATE TABLE answers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id  UUID NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  question_id  UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  option_id    UUID REFERENCES options(id) ON DELETE CASCADE,
  value_text   TEXT,
  value_num    NUMERIC
);

CREATE INDEX answers_response_idx ON answers (response_id);
CREATE INDEX answers_question_idx ON answers (question_id);

-- --------------------------------------------------------------- tally ------
CREATE TABLE tallies (
  poll_id    UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id  UUID NOT NULL REFERENCES options(id) ON DELETE CASCADE,
  count      BIGINT NOT NULL DEFAULT 0,

  PRIMARY KEY (poll_id, option_id)
);

-- -------------------------------------------------------------- invites -----
CREATE TABLE invite_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id    UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  email      TEXT,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (poll_id, code_hash)
);

ALTER TABLE responses
  ADD CONSTRAINT responses_invite_code_fk
  FOREIGN KEY (invite_code_id) REFERENCES invite_codes(id) ON DELETE SET NULL;

-- --------------------------------------------------------- rate limiting ----
-- Durable counters for limits that must survive a restart. In-process limits
-- live in rate-limiter-flexible's memory store; these back the ones that
-- cannot be allowed to reset.
CREATE TABLE rate_events (
  key           TEXT NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (key, window_start)
);

CREATE INDEX rate_events_window_idx ON rate_events (window_start);

-- ---------------------------------------------------------- notifications ---
CREATE TABLE push_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token        TEXT NOT NULL UNIQUE,
  provider     TEXT NOT NULL CHECK (provider IN ('expo', 'fcm_web')),
  platform     TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX push_tokens_user_idx ON push_tokens (user_id) WHERE revoked_at IS NULL;

CREATE TABLE notification_prefs (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  email       BOOLEAN NOT NULL DEFAULT true,
  push_mobile BOOLEAN NOT NULL DEFAULT true,
  push_web    BOOLEAN NOT NULL DEFAULT true,

  PRIMARY KEY (user_id, event_type)
);

-- ------------------------------------------------------------ moderation ----
CREATE TABLE reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id     UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'upheld', 'dismissed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX reports_open_idx ON reports (created_at) WHERE status = 'open';
