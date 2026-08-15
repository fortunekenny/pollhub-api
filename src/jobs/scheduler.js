import cron from 'node-cron';
import { closeDuePolls } from './close-polls.js';
import { warnClosingPolls } from './warn-closing-polls.js';
import { cleanupRateEvents } from './cleanup-rate-events.js';
import { logger } from '../lib/logger.js';

/**
 * In-process cron.
 *
 * Fine for a single instance, which is what v1 is. If a second instance ever
 * appears, these jobs will run twice — move to a systemd timer calling a CLI
 * entrypoint, or add a Postgres advisory lock around each job.
 */
export function startScheduler() {
  const tasks = [
    cron.schedule('* * * * *', () => run('close-polls', closeDuePolls)),
    // Every five minutes rather than every minute: the warning window is an
    // hour wide, so minute precision buys nothing and the query would run
    // sixty times an hour to find the same nothing.
    cron.schedule('*/5 * * * *', () => run('warn-closing-polls', warnClosingPolls)),
    cron.schedule('0 * * * *', () => run('cleanup-rate-events', cleanupRateEvents)),
  ];

  logger.info('scheduler started', { jobs: tasks.length });
  return () => tasks.forEach((t) => t.stop());
}

async function run(name, fn) {
  try {
    const result = await fn();
    if (result) logger.info(`job ${name}`, result);
  } catch (err) {
    // A failing job must never take the process down with it.
    logger.error(`job ${name} failed`, { err: err.message });
  }
}
