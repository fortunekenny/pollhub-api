import { pool } from '../db/pool.js';
import { CLOSING_WARNING_WINDOW } from '../config/constants.js';
import { notify, events } from '../modules/notifications/notifications.service.js';

/**
 * Warn owners about polls closing soon.
 *
 * The marker is claimed in the same statement that selects the work, rather
 * than read-then-write. A closing warning is the kind of thing that reads
 * fine and double-sends in practice: the job runs on a timer, and any overlap
 * — a slow tick, a redeploy mid-run, a second instance — would have two runs
 * agreeing the same poll needs warning. UPDATE ... RETURNING lets exactly one
 * of them win the row.
 *
 * Stamping before the notification is sent, not after, is the deliberate
 * trade: a failed send costs the owner one warning, whereas stamping
 * afterwards would re-notify on every tick for an hour if the send throws.
 * notify() already swallows its own failures, so a throw here means the
 * database is unreachable — in which case the stamp did not commit either.
 */
export async function warnClosingPolls() {
  const { rows } = await pool.query(
    `WITH due AS (
       UPDATE polls
          SET closing_notified_at = now()
        WHERE status = 'published'
          AND closes_at IS NOT NULL
          AND closes_at > now()
          AND closes_at <= now() + $1::interval
          AND closing_notified_at IS NULL
      RETURNING id, owner_id, title, response_count, closes_at
     )
     SELECT due.*, users.email AS owner_email
       FROM due
       JOIN users ON users.id = due.owner_id`,
    [CLOSING_WARNING_WINDOW],
  );

  for (const poll of rows) {
    await notify({
      userId: poll.owner_id,
      ...events.pollClosing(poll),
      link: `/polls/${poll.id}`,
      data: { email: poll.owner_email, pollId: poll.id },
    });
  }

  return rows.length > 0 ? { warned: rows.length } : null;
}
