import crypto from 'node:crypto';
import { env, features } from '../config/env.js';
import { badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Signed direct-to-Cloudinary uploads.
 *
 * The image bytes never touch this server: the client uploads straight to
 * Cloudinary using a signature we mint. That keeps a 24 GB ARM box (or a 1 GB
 * e2-micro) out of the image path entirely, and keeps the API secret here.
 *
 * The signature is scoped to an upload preset that caps dimensions, formats
 * and file size server-side — a client that alters those params invalidates
 * its own signature.
 */
export function signUpload({ folder = 'pollhub', publicId } = {}) {
  if (!features.uploads) throw badRequest('Image uploads are not configured');

  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    folder,
    timestamp,
    upload_preset: env.CLOUDINARY_UPLOAD_PRESET,
    ...(publicId ? { public_id: publicId } : {}),
  };

  // Cloudinary signs the alphabetically sorted query string plus the secret.
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');

  const signature = crypto
    .createHash('sha1')
    .update(toSign + env.CLOUDINARY_API_SECRET)
    .digest('hex');

  return {
    signature,
    timestamp,
    apiKey: env.CLOUDINARY_API_KEY,
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    folder,
    uploadPreset: env.CLOUDINARY_UPLOAD_PRESET,
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
  };
}

/**
 * Build a delivery URL from a stored public_id.
 *
 * Only the public_id is ever persisted — never a full URL. Storing URLs bakes
 * in the cloud name and transformation, so changing either means a migration.
 */
export function imageUrl(publicId, { width = 800, transform } = {}) {
  if (!publicId || !features.uploads) return null;
  const t = transform ?? `f_auto,q_auto,w_${width}`;
  return `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/${t}/${publicId}`;
}

/**
 * OG share card via URL text overlay.
 *
 * Deliberately not a headless browser: Chromium on a shared-core free VM is
 * the fastest way to exhaust 1 GB of RAM.
 */
export function shareCardUrl(publicId, title) {
  if (!features.uploads) return null;
  const base = publicId ?? 'pollhub/og-default';
  const text = encodeURIComponent(title.slice(0, 80)).replaceAll('%20', '%20');
  return (
    `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/` +
    `c_fill,w_1200,h_630/l_text:Arial_54_bold:${text},co_white,g_south_west,x_60,y_60,w_1080,c_fit/` +
    `${base}`
  );
}

/** Best-effort delete, used when a poll is hard-deleted. */
export async function destroyImage(publicId) {
  if (!features.uploads || !publicId) return { skipped: true };

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHash('sha1')
    .update(`public_id=${publicId}&timestamp=${timestamp}${env.CLOUDINARY_API_SECRET}`)
    .digest('hex');

  try {
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/destroy`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          public_id: publicId,
          timestamp,
          signature,
          api_key: env.CLOUDINARY_API_KEY,
        }),
      },
    );
    return { ok: res.ok };
  } catch (err) {
    logger.warn('cloudinary destroy failed', { err: err.message, publicId });
    return { ok: false };
  }
}
