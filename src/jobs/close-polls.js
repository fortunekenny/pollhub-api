import { pool } from '../db/pool.js';
import { publishPollStatus } from '../realtime/ws-server.js';
import { evict } from '../realtime/tally-mirror.js';
import { notify, events } from '../modules/notifications/notifications.service.js';
import { rollSeries } from '../modules/polls/polls.service.js';
import * as pollRepo from '../modules/polls/polls.repository.js';
import { logger } from '../lib/logger.js';

/**
 * Close polls whose `closes_at` has passed.
 *
 * This runs every minute, so it is the slow path — the vote endpoint also
 * checks `closes_at` on every submission, which is what actually stops a vote
 * landing in the gap between the deadline and the next tick.
 */
export async function closeDuePolls() {
  const { rows } = await pool.query(
    `UPDATE polls
        SET status = 'closed', updated_at = now()
      WHERE status = 'published'
        AND closes_at IS NOT NULL
        AND closes_at <= now()
  RETURNING id, owner_id, title, response_count`,
  );

  for (const poll of rows) {
    publishPollStatus(poll.id, 'closed');
    evict(poll.id);

    const { rows: owner } = await pool.query('SELECT email FROM users WHERE id = $1', [
      poll.owner_id,
    ]);
    await notify({
      userId: poll.owner_id,
      ...events.resultsReady(poll),
      data: { email: owner[0]?.email, pollId: poll.id },
    });

    // A repeating poll opens its next round as this one ends, so the series
    // link never points at a closed poll for longer than a tick.
    try {
      const next = await rollSeries(await pollRepo.findById(poll.id));
      if (next) logger.info('series rolled', { series: next.series_id, round: next.round });
    } catch (err) {
      // One series failing to roll must not stop the rest from closing.
      logger.error('series roll failed', { err: err.message, pollId: poll.id });
    }
  }

  return rows.length > 0 ? { closed: rows.length } : null;
}
