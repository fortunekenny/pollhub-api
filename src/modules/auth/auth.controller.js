import crypto from 'node:crypto';
import { env, isProd, crossSiteCookie } from '../../config/env.js';
import { REFRESH_TOKEN_TTL_DAYS } from '../../config/constants.js';
import * as service from './auth.service.js';
import * as repo from './auth.repository.js';

const COOKIE = 'ph_at';
const REFRESH_COOKIE = 'ph_rt';

/**
 * Scoped to the auth routes rather than '/'. The refresh token is the
 * long-lived credential here, so it should not ride along on every poll and
 * response request that has no use for it.
 */
const REFRESH_PATH = '/api/v1/auth';

function setAuthCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: 15 * 60 * 1000,
    path: '/',
  });
}

/**
 * httpOnly and signed, so page scripts can neither read nor forge it — which
 * is the whole reason the refresh token lives in a cookie while the access
 * token sits in localStorage. crossSiteCookie because in production the client
 * is on a different origin and a `lax` cookie would never be sent.
 */
function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    signed: true,
    ...crossSiteCookie,
    maxAge: REFRESH_TOKEN_TTL_DAYS * 86_400_000,
    path: REFRESH_PATH,
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { ...crossSiteCookie, path: REFRESH_PATH });
}

export async function signup(req, res) {
  const user = await service.signup(req.body);
  const token = service.issueToken(user);
  setAuthCookie(res, token);
  setRefreshCookie(res, await service.issueRefreshToken(user.id));
  res.status(201).json({ user: service.publicUser(user), token });
}

export async function login(req, res) {
  const user = await service.login(req.body);
  const token = service.issueToken(user);
  setAuthCookie(res, token);
  setRefreshCookie(res, await service.issueRefreshToken(user.id));
  res.json({ user: service.publicUser(user), token });
}

/**
 * Trade the refresh cookie for a new access token.
 *
 * Unauthenticated by design: the caller is here precisely because its access
 * token has expired. The cookie is the credential.
 */
export async function refresh(req, res) {
  const presented = req.signedCookies?.[REFRESH_COOKIE];

  let result;
  try {
    result = await service.rotateRefreshToken(presented);
  } catch (err) {
    // Clear on the way out, so a client holding a dead token stops retrying
    // with it on every request.
    clearRefreshCookie(res);
    throw err;
  }

  const token = service.issueToken(result.user);
  setAuthCookie(res, token);
  setRefreshCookie(res, result.refreshToken);
  res.json({ user: service.publicUser(result.user), token });
}

export async function logout(req, res) {
  // Revoke server-side too: clearing the cookie only stops this browser from
  // presenting it, and does nothing about a copy taken elsewhere.
  await service.revokeRefreshToken(req.signedCookies?.[REFRESH_COOKIE]);
  res.clearCookie(COOKIE, { path: '/' });
  clearRefreshCookie(res);
  res.status(204).end();
}

export async function me(req, res) {
  const user = await repo.findById(req.user.id);
  res.json({ user: service.publicUser(user) });
}

export async function verifyEmail(req, res) {
  const user = await service.verifyEmail(req.body.token);
  res.json({ user: service.publicUser(user) });
}

export async function requestPasswordReset(req, res) {
  await service.requestPasswordReset(req.body.email);
  // Same response whether or not the address exists.
  res.status(202).json({ message: 'If that address has an account, a reset link is on its way' });
}

export async function resetPassword(req, res) {
  const user = await service.resetPassword(req.body);
  res.json({ user: service.publicUser(user) });
}

export async function googleStart(req, res) {
  // State is bound to a cookie so the callback can prove it began here (CSRF).
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('ph_oauth_state', state, {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: 10 * 60 * 1000,
  });
  res.redirect(service.googleAuthUrl(state));
}

/**
 * Land the browser back on the client.
 *
 * Google navigates the browser here, so this endpoint's response is a page the
 * user looks at — a JSON body renders as raw text, and a thrown error renders
 * as the API's error envelope. Every exit has to be a redirect.
 *
 * The token travels in the fragment rather than the query string: fragments
 * are never sent to a server, so it stays out of Render's access logs, out of
 * any Referer header, and out of the client's own request telemetry.
 */
function backToClient(res, params) {
  res.redirect(`${env.APP_URL}/auth/callback#${new URLSearchParams(params)}`);
}

export async function googleCallback(req, res) {
  const { code, state } = req.query;

  if (!code) return backToClient(res, { error: 'Google did not return an authorization code' });
  if (!state || state !== req.signedCookies?.ph_oauth_state) {
    return backToClient(res, { error: 'Sign-in could not be verified. Please try again.' });
  }
  res.clearCookie('ph_oauth_state');

  let token;
  let refreshToken;
  try {
    const user = await service.googleCallback(code);
    token = service.issueToken(user);
    // Google sign-in gets the same durable session as a password sign-in —
    // otherwise it would be the one route that still expires after 15 minutes.
    refreshToken = await service.issueRefreshToken(user.id);
  } catch (err) {
    // A badRequest here would reach the error handler and render JSON, which
    // is the exact failure this function exists to avoid.
    return backToClient(res, { error: err.message ?? 'Google sign-in failed' });
  }

  setAuthCookie(res, token);
  setRefreshCookie(res, refreshToken);
  backToClient(res, { token });
}
