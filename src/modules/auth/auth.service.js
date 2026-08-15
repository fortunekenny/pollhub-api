import jwt from 'jsonwebtoken';
import { env, features } from '../../config/env.js';
import { ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL_DAYS } from '../../config/constants.js';
import * as repo from './auth.repository.js';
import { hashPassword, verifyPassword, randomToken, tokenHash } from '../../lib/hash.js';
import { badRequest, conflict, forbidden, unauthorized } from '../../lib/errors.js';
import { sendEmail } from '../../integrations/brevo.js';
import { logger } from '../../lib/logger.js';

const VERIFY_TTL_HOURS = 24;
const RESET_TTL_MINUTES = 30;

export function issueToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL, issuer: 'pollhub' },
  );
}

/**
 * Mint a refresh token. Returned raw; only its hash is stored.
 */
export async function issueRefreshToken(userId) {
  const token = randomToken();
  await repo.createRefreshToken({
    userId,
    tokenHash: tokenHash(token),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000),
  });
  return token;
}

/**
 * Trade a refresh token for a fresh pair.
 *
 * Rotating on every use means a stolen token is only useful until the real
 * client refreshes once — after that the thief presents an already-revoked
 * token, which is the detection. The response to detection is to revoke the
 * whole family rather than just that token: once two parties hold tokens from
 * one lineage there is no way to tell which is the legitimate one, so both are
 * made to sign in again.
 *
 * A client that never received the response to its own rotation lands here
 * too, and is signed out. That is the deliberate trade — a rare spurious
 * sign-out costs less than a replayable month-long credential.
 */
export async function rotateRefreshToken(token) {
  if (!token) throw unauthorized('Your session has expired');

  const hash = tokenHash(token);
  const claimed = await repo.claimRefreshToken(hash);

  if (!claimed) {
    const known = await repo.findRefreshToken(hash);
    if (known?.revoked_at) {
      const count = await repo.revokeAllRefreshTokens(known.user_id);
      logger.warn('refresh token reuse detected', { userId: known.user_id, revoked: count });
    }
    throw unauthorized('Your session has expired');
  }

  const user = await repo.findById(claimed.user_id);
  if (!user) throw unauthorized('Your session has expired');
  // Checked on every refresh, not just at login: a suspension must take effect
  // within the access token's lifetime, not a month later.
  if (user.suspended_at) throw forbidden('This account has been suspended');

  return { user, refreshToken: await issueRefreshToken(user.id) };
}

export async function revokeRefreshToken(token) {
  if (token) await repo.revokeRefreshToken(tokenHash(token));
}

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatarPublicId: user.avatar_public_id,
    verified: Boolean(user.verified_at),
    createdAt: user.created_at,
  };
}

export async function signup({ email, password, name }) {
  const existing = await repo.findByEmail(email);
  if (existing) throw conflict('An account with that email already exists', 'email_taken');

  const user = await repo.createUser({
    email,
    passwordHash: await hashPassword(password),
    name,
  });

  await sendVerificationEmail(user);
  return user;
}

export async function sendVerificationEmail(user) {
  const token = randomToken();
  await repo.createEmailToken({
    userId: user.id,
    tokenHash: tokenHash(token),
    purpose: 'verify_email',
    expiresAt: new Date(Date.now() + VERIFY_TTL_HOURS * 3600_000),
  });

  const link = `${env.APP_URL}/verify-email?token=${token}`;
  await sendEmail({
    to: user.email,
    subject: 'Verify your PollHub account',
    html: `<p>Hi ${escapeHtml(user.name)},</p>
           <p>Confirm your email to start publishing polls:</p>
           <p><a href="${link}">Verify my email</a></p>
           <p>This link expires in ${VERIFY_TTL_HOURS} hours.</p>`,
  });

  // Without Brevo configured the link only reaches the log — that is the
  // intended local-dev path, not an error.
  if (!features.email) logger.info('verification link', { link });
}

export async function login({ email, password }) {
  const user = await repo.findByEmail(email);

  // Always run a hash comparison, even when no user matched, so response
  // timing does not reveal which emails are registered.
  const ok = await verifyPassword(password, user?.password_hash ?? '$scrypt$0$0$0$AA==$AA==');
  if (!user || !ok) throw unauthorized('Incorrect email or password');
  if (user.suspended_at) throw forbidden('This account has been suspended');

  return user;
}

export async function verifyEmail(token) {
  const record = await repo.consumeEmailToken(tokenHash(token), 'verify_email');
  if (!record) throw badRequest('That verification link is invalid or has expired');

  await repo.markVerified(record.user_id);
  return repo.findById(record.user_id);
}

export async function requestPasswordReset(email) {
  const user = await repo.findByEmail(email);

  // Silently succeed for unknown addresses: a 404 here is an account
  // enumeration oracle.
  if (!user) return;

  const token = randomToken();
  await repo.createEmailToken({
    userId: user.id,
    tokenHash: tokenHash(token),
    purpose: 'reset_password',
    expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
  });

  const link = `${env.APP_URL}/reset-password?token=${token}`;
  await sendEmail({
    to: user.email,
    subject: 'Reset your PollHub password',
    html: `<p>Someone asked to reset your password.</p>
           <p><a href="${link}">Choose a new password</a></p>
           <p>This link expires in ${RESET_TTL_MINUTES} minutes. If this wasn't you, ignore this email.</p>`,
  });

  if (!features.email) logger.info('password reset link', { link });
}

export async function resetPassword({ token, password }) {
  const record = await repo.consumeEmailToken(tokenHash(token), 'reset_password');
  if (!record) throw badRequest('That reset link is invalid or has expired');

  await repo.setPassword(record.user_id, await hashPassword(password));
  // Resetting through an emailed link proves control of the address.
  await repo.markVerified(record.user_id);
  return repo.findById(record.user_id);
}

// ---------------------------------------------------------------- google ----

export function googleAuthUrl(state) {
  if (!features.googleOAuth) throw badRequest('Google sign-in is not configured');

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function googleCallback(code) {
  if (!features.googleOAuth) throw badRequest('Google sign-in is not configured');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) throw badRequest('Google rejected the sign-in attempt');

  const { id_token: idToken } = await res.json();
  const claims = jwt.decode(idToken);
  if (!claims?.email) throw badRequest('Google did not return an email address');

  // Google has already verified the address, so these accounts skip the
  // verification email entirely.
  const existingBySub = await repo.findByGoogleSub(claims.sub);
  if (existingBySub) return existingBySub;

  const existingByEmail = await repo.findByEmail(claims.email);
  if (existingByEmail) return repo.linkGoogle(existingByEmail.id, claims.sub);

  return repo.createUser({
    email: claims.email,
    name: claims.name ?? claims.email.split('@')[0],
    googleSub: claims.sub,
    verifiedAt: new Date(),
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
