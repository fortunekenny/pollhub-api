-- Repeating polls: a series of rounds behind one permanent link.
--
-- Each round is an ordinary poll row. That is the whole design decision — a
-- round gets results, analytics, CSV export, invite codes and a tally mirror
-- for free, because it is not a special kind of thing. The alternative, one
-- poll row with rounds hanging off it, would have meant teaching every one of
-- those features what a round is.
--
-- What rounds share is the link. `series_slug` is stable for the life of the
-- series while `slug` stays unique per round, so a link shared once in January
-- still resolves to whichever round is open today, and every past round is
-- still individually addressable for its own results. A recurring poll whose
-- URL expired every week would not be much of a recurring poll.

ALTER TABLE polls ADD COLUMN series_id       UUID;
ALTER TABLE polls ADD COLUMN series_slug     TEXT;
ALTER TABLE polls ADD COLUMN repeat_interval TEXT
  CHECK (repeat_interval IN ('daily', 'weekly', 'monthly'));
ALTER TABLE polls ADD COLUMN round           INTEGER NOT NULL DEFAULT 1;

-- Deliberately NOT unique: every round in a series carries the same value.
-- Resolution picks among them by status and schedule, not by uniqueness.
CREATE INDEX polls_series_slug_idx ON polls (series_slug) WHERE series_slug IS NOT NULL;

-- Rounds of one series, newest first — the series view, and the lookup that
-- decides which round a bare series link should open.
CREATE INDEX polls_series_round_idx ON polls (series_id, round DESC) WHERE series_id IS NOT NULL;

-- A series slug must not collide with any round's own slug, or a link would be
-- ambiguous. slug already carries a unique index from 001; the cross-check
-- against series_slug lives in polls.service.startSeries, which retries on a
-- collision the same way slug allocation already does.
