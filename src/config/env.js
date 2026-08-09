import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  PUBLIC_POLL_BASE_URL: z.string().url().default('http://localhost:3000/p'),

  // Comma-separated browser origins allowed to send credentialed requests.
  // Blank reflects whatever origin asks, which is only safe while no cookie
  // crosses sites — see the production check below.
  CLIENT_ORIGIN: z.string().default(''),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool.default('false'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  COOKIE_SECRET: z.string().min(32, 'COOKIE_SECRET must be at least 32 characters'),
  HASH_PEPPER: z.string().min(32, 'HASH_PEPPER must be at least 32 characters'),

  BEHIND_CLOUDFLARE: bool.default('false'),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REDIRECT_URI: z.string().default(''),

  BREVO_API_KEY: z.string().default(''),
  MAIL_FROM_EMAIL: z.string().default('no-reply@example.com'),
  MAIL_FROM_NAME: z.string().default('PollHub'),

  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),
  CLOUDINARY_UPLOAD_PRESET: z.string().default('pollhub_signed'),

  TURNSTILE_SECRET_KEY: z.string().default(''),

  EXPO_ACCESS_TOKEN: z.string().default(''),
  FCM_PROJECT_ID: z.string().default(''),
  FCM_CLIENT_EMAIL: z.string().default(''),
  FCM_PRIVATE_KEY: z.string().default(''),
}).superRefine((cfg, ctx) => {
  // In production the client is served from its own origin, so the device-id
  // cookie has to be SameSite=None to survive the trip. That makes it a cookie
  // any site can cause the browser to attach — and a credentialed CORS policy
  // that reflects every origin would then let any page drive a request with it.
  // Pinning the origin is what closes that, so it is not optional here.
  if (cfg.NODE_ENV === 'production' && !cfg.CLIENT_ORIGIN.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CLIENT_ORIGIN'],
      message:
        'required in production — set it to the client origin, e.g. https://pollhub-client.onrender.com',
    });
  }
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // Fail fast and loudly: a half-configured process that boots is worse than
  // one that refuses to.
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Allowed browser origins. Empty means reflect the caller (development). */
export const clientOrigins = env.CLIENT_ORIGIN.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Cross-site cookies.
 *
 * Dev serves the client through Vite's proxy, so browser and API share an
 * origin and `lax` holds. Production splits them, and a `lax` cookie is not
 * sent on a cross-site fetch — which would silently break `cookie_device`
 * dedup, the default for every poll.
 */
export const crossSiteCookie = isProd
  ? { sameSite: 'none', secure: true }
  : { sameSite: 'lax', secure: false };

/** Which optional integrations are actually wired up. */
export const features = {
  googleOAuth: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  email: Boolean(env.BREVO_API_KEY),
  uploads: Boolean(
    env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
  ),
  turnstile: Boolean(env.TURNSTILE_SECRET_KEY),
  pushMobile: true, // Expo accepts unauthenticated sends; token is optional
  pushWeb: Boolean(env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY),
};
