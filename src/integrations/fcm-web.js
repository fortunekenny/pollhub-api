import jwt from 'jsonwebtoken';
import { env, features } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Web push via FCM HTTP v1.
 *
 * Implemented against the REST API with a self-signed service-account JWT
 * rather than pulling in firebase-admin: that package is tens of megabytes
 * for the one endpoint used here, and this deploy target has no Docker layer
 * cache to hide the weight.
 *
 * The legacy FCM HTTP API is shut down — v1 with OAuth2 is the only option.
 */
let cachedToken = null; // { value, expiresAt }

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: env.FCM_CLIENT_EMAIL,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    // Env files cannot hold real newlines, so the key is stored escaped.
    env.FCM_PRIVATE_KEY.replaceAll('\\n', '\n'),
    { algorithm: 'RS256' },
  );

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) throw new Error(`FCM token exchange failed: ${res.status}`);

  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.value;
}

/**
 * FCM v1 sends one message per request — there is no batch endpoint. Sends
 * run concurrently and dead tokens come back for revocation.
 */
export async function sendWebPush(messages) {
  if (!features.pushWeb || messages.length === 0) return { dead: [] };

  let token;
  try {
    token = await accessToken();
  } catch (err) {
    logger.warn('fcm auth failed', { err: err.message });
    return { dead: [] };
  }

  const url = `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`;
  const dead = [];

  await Promise.all(
    messages.map(async (m) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: m.token,
              notification: { title: m.title, body: m.body },
              webpush: {
                fcmOptions: { link: m.link },
                notification: { icon: '/icon-192.png' },
              },
              data: Object.fromEntries(
                Object.entries(m.data ?? {}).map(([k, v]) => [k, String(v)]),
              ),
            },
          }),
        });

        if (res.status === 404 || res.status === 403) {
          // UNREGISTERED / SENDER_ID_MISMATCH — the token is permanently dead.
          dead.push(m.token);
        } else if (!res.ok) {
          logger.warn('fcm send failed', { status: res.status });
        }
      } catch (err) {
        logger.warn('fcm send threw', { err: err.message });
      }
    }),
  );

  return { dead };
}
