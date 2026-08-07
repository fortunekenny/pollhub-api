import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, closePool } from './pool.js';

const DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function applied() {
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  return new Set(rows.map((r) => r.name));
}

async function files() {
  const entries = await readdir(DIR);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

async function up() {
  await ensureTable();
  const done = await applied();
  const all = await files();
  const pending = all.filter((f) => !done.has(f));

  if (pending.length === 0) {
    console.log('No pending migrations.');
    return;
  }

  for (const name of pending) {
    const sql = await readFile(path.join(DIR, name), 'utf8');
    const client = await pool.connect();
    try {
      // Each migration is one transaction: it applies completely or not at all.
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`applied  ${name}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`FAILED   ${name}\n${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }
}

async function status() {
  await ensureTable();
  const done = await applied();
  for (const name of await files()) {
    console.log(`${done.has(name) ? '[x]' : '[ ]'} ${name}`);
  }
}

const command = process.argv[2] ?? 'up';

try {
  if (command === 'up') await up();
  else if (command === 'status') await status();
  else {
    console.error(`Unknown command: ${command}. Use "up" or "status".`);
    process.exitCode = 1;
  }
} catch {
  process.exitCode = 1;
} finally {
  await closePool();
}
