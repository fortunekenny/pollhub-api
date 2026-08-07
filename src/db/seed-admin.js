import { closePool } from './pool.js';
import { withTransaction } from './transaction.js';
import { hashPassword, randomToken } from '../lib/hash.js';
import { isProd } from '../config/env.js';

/**
 * Bootstraps an admin account — the one user that can reach
 * /moderation, which is gated behind requireRole('admin').
 *
 * Kept apart from seed.js on purpose: that script invents demo content and is
 * development-only, while this one is expected to run once against a real
 * database. So it takes its credentials from the environment rather than
 * hardcoding them, and never fabricates polls.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... npm run seed:admin
 *   npm run seed:admin -- you@example.com          # password generated
 *
 * Idempotent: re-running promotes the existing user instead of failing on the
 * unique email index. The password is only touched when one is supplied, so a
 * repeat run cannot silently lock an admin out of their own account.
 */

const MIN_PASSWORD_LENGTH = 12;

function readArgs() {
  const [emailArg, passwordArg] = process.argv.slice(2);
  const email = (emailArg ?? process.env.ADMIN_EMAIL ?? '').trim();
  const password = passwordArg ?? process.env.ADMIN_PASSWORD ?? '';
  const name = (process.env.ADMIN_NAME ?? '').trim() || 'Admin';

  if (!email) {
    throw new Error(
      'No admin email. Pass one as an argument or set ADMIN_EMAIL.\n' +
        '  ADMIN_EMAIL=you@example.com npm run seed:admin',
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`Not a valid email address: ${email}`);
  }
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  // A generated password beats a guessable one, but it is printed to stdout —
  // acceptable for a one-off bootstrap, and the operator can rotate it after.
  const generated = password ? null : randomToken(12);
  return { email, name, password: password || generated, generated };
}

async function seedAdmin() {
  const { email, name, password, generated } = readArgs();
  const passwordHash = await hashPassword(password);

  await withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      'SELECT id, role FROM users WHERE lower(email) = lower($1)',
      [email],
    );

    if (existing[0]) {
      const { id, role } = existing[0];
      // Clear suspended_at and stamp verified_at as well: an admin that cannot
      // sign in because it was never verified is not a useful admin.
      await client.query(
        `UPDATE users
            SET role          = 'admin',
                password_hash = CASE WHEN $2::boolean THEN $3 ELSE password_hash END,
                verified_at   = COALESCE(verified_at, now()),
                suspended_at  = NULL
          WHERE id = $1`,
        [id, !generated, passwordHash],
      );

      console.log(
        role === 'admin'
          ? `Admin ${email} already existed — verified and unsuspended.`
          : `Promoted ${email} from '${role}' to 'admin'.`,
      );
      if (generated) {
        console.log('Password left unchanged. Set ADMIN_PASSWORD to reset it.');
      } else {
        console.log('Password updated.');
      }
      return;
    }

    await client.query(
      `INSERT INTO users (email, password_hash, name, role, verified_at)
            VALUES ($1, $2, $3, 'admin', now())`,
      [email, passwordHash, name],
    );

    console.log(`Created admin: ${email}`);
    if (generated) {
      console.log(`Generated password: ${generated}`);
      console.log('Store it now — it is not recoverable, only replaceable.');
    }
  });

  if (isProd && generated) {
    console.warn('\nWarning: a generated password was printed in a production run.');
  }
}

try {
  await seedAdmin();
} catch (err) {
  console.error(`Admin seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
