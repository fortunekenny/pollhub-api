import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100; // Expo's documented maximum per request

/**
 * Mobile push via Expo, which relays to FCM (Android) and APNs (iOS).
 *
 * Returns the tokens Expo reports as dead so the caller can revoke them —
 * pruning matters, because a token that keeps failing counts against send
 * throughput forever.
 */
export async function sendExpoPush(messages) {
  if (messages.length === 0) return { dead: [] };

  const dead = [];

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(SEND_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(env.EXPO_ACCESS_TOKEN
            ? { authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` }
            : {}),
        },
        body: JSON.stringify(batch),
      });

      if (!res.ok) {
        logger.warn('expo push batch failed', { status: res.status });
        continue;
      }

      const { data } = await res.json();
      data?.forEach((ticket, idx) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          dead.push(batch[idx].to);
        }
      });
    } catch (err) {
      logger.warn('expo push threw', { err: err.message });
    }
  }

  return { dead };
}

export function expoMessage({ token, title, body, data }) {
  return { to: token, title, body, data, sound: 'default', priority: 'high' };
}
