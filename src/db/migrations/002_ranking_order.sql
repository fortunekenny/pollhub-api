-- Ranking questions need the respondent's ORDER, not just their selection.
--
-- Until now a ranking was stored exactly like a multiple choice: one answer
-- row per option, no position. The order the respondent chose was discarded on
-- submit, so results could not distinguish a first place from a last place —
-- with everyone ranking every option, all options tied.
--
-- Two columns fix that:
--
--   answers.rank      1-based position within that respondent's ordering.
--                     NULL for every other question type, and NULL for
--                     ranking answers recorded before this migration.
--
--   tallies.rank_sum  Running total of positions, incremented alongside count
--                     on each submission. Average position is rank_sum/count,
--                     which keeps ranking results on the same incremental
--                     counter the live tally push already uses — no extra
--                     aggregate query per viewer.
--
-- Both are additive and backfill-free. Pre-existing ranking answers keep
-- contributing to `count` and simply carry no position, so their average is
-- computed from the responses that do have one.

ALTER TABLE answers ADD COLUMN rank SMALLINT;

ALTER TABLE tallies ADD COLUMN rank_sum BIGINT NOT NULL DEFAULT 0;

-- Ranked answers are always read per question, ordered by position.
CREATE INDEX answers_rank_idx ON answers (question_id, rank) WHERE rank IS NOT NULL;
