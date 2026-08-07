# PollHub API

Backend for PollHub — a voting and survey platform. Express 5 + PostgreSQL + `ws`,
in JavaScript (ES modules). No Redis, no Docker, no build step.

See [`voting-survey-system-brief.md`](./voting-survey-system-brief.md) for the product brief.

## Requirements

- Node.js ≥ 20.11
- PostgreSQL ≥ 14

No other services are required to run locally. Brevo, Cloudinary, Turnstile,
Google OAuth and push are all optional — when their environment variables are
unset the API still boots and those features degrade to no-ops (emails are
logged instead of sent, uploads return a clear error). `GET /health` reports
which are live.

## Getting started

```bash
cp .env.example .env      # then fill in DATABASE_URL and the three secrets
npm install
npm run migrate
npm run seed              # optional: demo creator + published poll
npm run dev
```

Generate the secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Start with `node --watch` |
| `npm start` | Start once |
| `npm run migrate` | Apply pending migrations |
| `npm run migrate:status` | Show applied / pending |
| `npm run seed` | Insert demo data |
| `npm test` | Run the test suite |

## Layout

```
src/
├── server.js          HTTP server, ws attach, graceful shutdown
├── app.js             Express app, middleware chain, route mount
├── config/            env validation, trust-proxy allowlist, constants
├── db/                pool, transaction helper, migrations, seed
├── middleware/        client-ip, auth, validate, rate-limit, errors
├── modules/           feature modules (routes/controller/service/repository/schema)
├── realtime/          ws server, channel registry, tally mirror
├── integrations/      thin clients: Brevo, Cloudinary, Turnstile, Expo, FCM
├── jobs/              node-cron scheduler
└── lib/               hash, slug, csv, qr, errors, logger
```

Each module keeps the same five files, so a module you did not write is
navigable: `*.routes.js`, `*.controller.js`, `*.service.js`,
`*.repository.js`, `*.schema.js`. SQL lives only in repositories; controllers
touch only `req`/`res`.

## API

Base path `/api/v1`.

### Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/signup` | Sends a verification email |
| POST | `/auth/login` | Returns a JWT and sets a signed cookie |
| POST | `/auth/logout` | |
| GET | `/auth/me` | |
| POST | `/auth/verify-email` | |
| POST | `/auth/password/request-reset` | Always 202 — never reveals whether the address exists |
| POST | `/auth/password/reset` | |
| GET | `/auth/google` → `/auth/google/callback` | |

### Polls
| Method | Path | Auth |
|---|---|---|
| POST | `/polls` | creator |
| GET | `/polls` | creator |
| GET | `/polls/:id` | owner |
| PATCH | `/polls/:id` | owner |
| POST | `/polls/:id/publish` `/close` `/archive` `/duplicate` | owner |
| GET | `/polls/public` | public |
| GET | `/polls/slug/:slug` | public (optional auth) |
| GET | `/polls/:id/qr.svg` | public |

### Responding
| Method | Path | Auth |
|---|---|---|
| POST | `/polls/:slug/responses` | optional — the poll's `identityMode` decides |
| GET | `/polls/:slug/status` | optional |

### Results, invites, uploads, notifications, moderation
| Method | Path | Auth |
|---|---|---|
| GET | `/polls/:id/analytics` | owner |
| GET | `/polls/:id/export.csv` | owner |
| POST/GET | `/polls/:id/invites` | owner |
| POST | `/uploads/sign` | creator |
| POST/DELETE | `/notifications/tokens` | creator |
| GET/PUT | `/notifications/preferences` | creator |
| POST | `/moderation/reports` | public |
| GET/POST | `/moderation/reports…` | admin |

### WebSocket

Connect to `/ws`, then:

```json
{ "type": "subscribe", "pollId": "<uuid>" }
```

The server replies with a `snapshot` and then pushes `tally` deltas as votes
land, plus a `status` frame when the poll closes. Results visibility is
enforced on subscribe, so a `creator_only` poll does not leak its tally over
the socket.

## Four things worth knowing before you change anything

**1. `trust proxy` is never `true`.** `src/config/trust-proxy.js` holds an
explicit Cloudflare range allowlist. Setting it to boolean `true` trusts
`X-Forwarded-For` from any source, letting a client spoof its address and
defeat deduplication entirely — while the results page still claims the poll
was protected. Refresh the ranges from https://www.cloudflare.com/ips/
periodically.

**2. Deduplication is a database constraint, not application code.** Partial
unique indexes on `responses` enforce it; the vote path just inserts and
catches `23505`. There is deliberately no check-then-insert, because that
leaves a window where two simultaneous votes both pass the check.

**3. The tally increment shares the response insert's transaction.** That is
why every repository function takes an optional client as its last argument —
the caller owns the transaction boundary. Split across two connections, a
crash between them leaves the tally disagreeing with the responses table.

**4. Single process is a design constraint.** The in-memory rate limiter, the
tally mirror and the WebSocket client set all live in process memory, and
`node-cron` runs in-process. `ecosystem.config.js` therefore pins
`instances: 1`. Running two instances silently breaks all four.

## Deployment

Ubuntu VM, no containers:

```bash
sudo -u postgres createuser pollhub --pwprompt
sudo -u postgres createdb pollhub --owner pollhub

git clone <repo> /srv/pollhub-api && cd /srv/pollhub-api
npm ci --omit=dev
cp .env.example .env      # fill in
npm run migrate

npm i -g pm2
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

Caddy handles TLS and proxies to `:3000` — one `reverse_proxy` line, with
Let's Encrypt automatic. Subsequent deploys: `./scripts/deploy.sh`.

Set up `scripts/backup.sh` in cron on day one. Free cloud accounts carry no
SLA, and the backup plus the deploy script are what make rebuilding elsewhere
within an hour realistic. Test the restore, not just the backup.

## Testing

```bash
npm test
```

The current suite covers pure logic — CSV escaping including formula
injection, password hashing, identity hashing, slug generation, poll schema
rules and the trust-proxy guard. Integration tests that exercise the vote
transaction need a live Postgres and are the obvious next thing to write:
concurrent duplicate submission, two voters behind one NAT, and tally
correctness under parallel votes.
