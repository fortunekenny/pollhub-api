import { env, features } from '../config/env.js';
import { logger } from '../lib/logger.js';

const ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

/**
 * Transactional email.
 *
 * Free plan is ~300/day across ALL transactional mail, so verification
 * competes with poll reminders for the same quota. Send failures never throw
 * into a request path — a signup must not 500 because Brevo is down.
 *
 * Deliverability is a DNS problem, not a code problem: without SPF, DKIM and
 * DMARC on the sending domain this lands in spam regardless of what we do.
 */
export async function sendEmail({ to, subject, html, text }) {
  if (!features.email) {
    logger.info('email (not configured, logged only)', { to, subject });
    return { skipped: true };
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text ?? stripTags(html),
      }),
    });

    if (!res.ok) {
      logger.warn('brevo send failed', { status: res.status, body: await res.text() });
      return { sent: false };
    }
    return { sent: true };
  } catch (err) {
    logger.warn('brevo send threw', { err: err.message });
    return { sent: false };
  }
}

function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
