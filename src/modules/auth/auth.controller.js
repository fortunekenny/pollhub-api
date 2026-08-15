import crypto from 'node:crypto';
import { env, isProd } from '../../config/env.js';
import * as service from './auth.service.js';
import * as repo from './auth.repository.js';
import { badRequest } from '../../lib/errors.js';

const COOKIE = 'ph_at';

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

export async function signup(req, res) {
  const user = await service.signup(req.body);
  const token = service.issueToken(user);
  setAuthCookie(res, token);
  res.status(201).json({ user: service.publicUser(user), token });
}

export async function login(req, res) {
  const user = await service.login(req.body);
  const token = service.issueToken(user);
  setAuthCookie(res, token);
  res.json({ user: service.publicUser(user), token });
}

export async function logout(_req, res) {
  res.clearCookie(COOKIE, { path: '/' });
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
  try {
    const user = await service.googleCallback(code);
    token = service.issueToken(user);
  } catch (err) {
    // A badRequest here would reach the error handler and render JSON, which
    // is the exact failure this function exists to avoid.
    return backToClient(res, { error: err.message ?? 'Google sign-in failed' });
  }

  setAuthCookie(res, token);
  backToClient(res, { token });
}
