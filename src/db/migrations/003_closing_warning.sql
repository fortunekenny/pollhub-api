-- The "poll closing soon" notification needs to remember it already fired.
--
-- Unlike results_ready, which is a side effect of a state change the database
-- already records (published -> closed), a closing warning has no state of its
-- own. The job that sends it runs on an interval and asks "which polls close
-- within the next hour" — a question that keeps answering yes for the whole
-- hour. Without a marker the owner is notified on every tick until the poll
-- actually closes.
--
-- Nullable with no default, so every existing poll starts unwarned. A poll
-- already inside its warning window when this lands gets one warning on the
-- next tick, which is the desired behaviour rather than an edge case.
--
-- Reset to NULL whenever closes_at moves (see polls.repository.updatePoll):
-- a rescheduled deadline is a new deadline, and it deserves its own warning.

ALTER TABLE polls ADD COLUMN closing_notified_at TIMESTAMPTZ;

-- The warning job filters on exactly this shape. Partial, because the rows it
-- must never look at — drafts, closed polls, polls with no deadline — are the
-- overwhelming majority once the table grows.
CREATE INDEX polls_closing_soon_idx
    ON polls (closes_at)
 WHERE status = 'published'
   AND closes_at IS NOT NULL
   AND closing_notified_at IS NULL;
