import * as repo from './notifications.repository.js';
import { sendEmail } from '../../integrations/brevo.js';
import { sendExpoPush, expoMessage } from '../../integrations/expo-push.js';
import { sendWebPush } from '../../integrations/fcm-web.js';
import { logger } from '../../lib/logger.js';

/**
 * One fan-out point for every channel.
 *
 * Callers raise an event; this decides which of email, mobile push and web
 * push it becomes, based on the user's preferences. Three parallel call sites
 * at every trigger is how notification preferences quietly stop being obeyed.
 *
 * Never throws into a request path — a poll must still close if Brevo is down.
 */
export async function notify({ userId, event, title, body, link, data }) {
  try {
    const [prefs, tokens] = await Promise.all([
      repo.prefsFor(userId, event),
      repo.activeTokens(userId),
    ]);

    const jobs = [];

    if (prefs.email && data?.email) {
      jobs.push(sendEmail({ to: data.email, subject: title, html: `<p>${body}</p>` }));
    }

    if (prefs.push_mobile) {
      const mobile = tokens.filter((t) => t.provider === 'expo');
      if (mobile.length > 0) {
        jobs.push(
          sendExpoPush(mobile.map((t) => expoMessage({ token: t.token, title, body, data })))
            .then(({ dead }) => repo.revokeMany(dead)),
        );
      }
    }

    if (prefs.push_web) {
      const web = tokens.filter((t) => t.provider === 'fcm_web');
      if (web.length > 0) {
        jobs.push(
          sendWebPush(web.map((t) => ({ token: t.token, title, body, link, data })))
            .then(({ dead }) => repo.revokeMany(dead)),
        );
      }
    }

    await Promise.allSettled(jobs);
  } catch (err) {
    logger.warn('notify failed', { err: err.message, event, userId });
  }
}

export const events = {
  pollClosing: (poll) => ({
    event: 'poll_closing',
    title: 'Your poll is closing soon',
    body: `"${poll.title}" closes shortly. ${poll.response_count} responses so far.`,
  }),
  resultsReady: (poll) => ({
    event: 'results_ready',
    title: 'Your poll has closed',
    body: `"${poll.title}" is closed with ${poll.response_count} responses.`,
  }),
  responseMilestone: (poll, milestone) => ({
    event: 'response_milestone',
    title: `${milestone} responses`,
    body: `"${poll.title}" has passed ${milestone} responses.`,
  }),
};
