import crypto from 'node:crypto';
import { isProd } from '../../config/env.js';
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

export async function googleCallback(req, res) {
  const { code, state } = req.query;
  if (!code) throw badRequest('Missing authorization code');
  if (!state || state !== req.signedCookies?.ph_oauth_state) {
    throw badRequest('Invalid OAuth state');
  }
  res.clearCookie('ph_oauth_state');

  const user = await service.googleCallback(code);
  const token = service.issueToken(user);
  setAuthCookie(res, token);
  res.json({ user: service.publicUser(user), token });
}
