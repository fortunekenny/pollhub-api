import { pool, closePool } from './pool.js';
import { withTransaction } from './transaction.js';
import { hashPassword } from '../lib/hash.js';
import { generateSlug } from '../lib/slug.js';

/**
 * Development seed: one verified creator and one published Quick Vote with
 * tallies already seeded, so the dashboard and respondent page have something
 * to render before anyone writes a fixture.
 */
async function seed() {
  await withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      "SELECT id FROM users WHERE email = 'demo@pollhub.local'",
    );
    if (existing[0]) {
      console.log('Seed data already present — nothing to do.');
      return;
    }

    const { rows: users } = await client.query(
      `INSERT INTO users (email, password_hash, name, verified_at)
            VALUES ($1,$2,$3, now()) RETURNING id`,
      ['demo@pollhub.local', await hashPassword('demo-password'), 'Demo Creator'],
    );
    const ownerId = users[0].id;

    const slug = generateSlug();
    const { rows: polls } = await client.query(
      `INSERT INTO polls (owner_id, type, title, description, slug, visibility,
                          identity_mode, dedup_mode, results_mode, status, published_at)
            VALUES ($1,'vote',$2,$3,$4,'public','anonymous','cookie_device','live','published', now())
         RETURNING id`,
      [ownerId, 'Where should we host the meetup?', 'Pick one venue.', slug],
    );
    const pollId = polls[0].id;

    const { rows: questions } = await client.query(
      `INSERT INTO questions (poll_id, position, type, prompt, required)
            VALUES ($1, 0, 'single_choice', $2, true) RETURNING id`,
      [pollId, 'Where should we host the meetup?'],
    );

    for (const [i, label] of ['Yaba', 'Lekki', 'Ikeja'].entries()) {
      const { rows: options } = await client.query(
        `INSERT INTO options (question_id, position, label)
              VALUES ($1,$2,$3) RETURNING id`,
        [questions[0].id, i, label],
      );
      await client.query(
        'INSERT INTO tallies (poll_id, option_id, count) VALUES ($1,$2,0)',
        [pollId, options[0].id],
      );
    }

    console.log(`Seeded. Login: demo@pollhub.local / demo-password`);
    console.log(`Poll:  /p/${slug}`);
  });
}

try {
  await seed();
} catch (err) {
  console.error(`Seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
