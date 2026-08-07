import { isProd } from '../config/env.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? (isProd ? LEVELS.info : LEVELS.debug);

function emit(level, msg, meta) {
  if (LEVELS[level] < threshold) return;

  if (isProd) {
    // Structured lines so `journalctl -o cat | jq` stays usable on the VM.
    process.stdout.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta })}\n`,
    );
    return;
  }
  const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  process.stdout.write(`${level.padEnd(5)} ${msg}${suffix}\n`);
}

export const logger = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};
