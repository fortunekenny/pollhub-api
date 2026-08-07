import http from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { attachWebSocket } from './realtime/ws-server.js';
import { startScheduler } from './jobs/scheduler.js';
import { closePool } from './db/pool.js';
import { logger } from './lib/logger.js';

const app = createApp();

// One HTTP server for both REST and WebSocket. The live-results design needs
// a persistent process holding these connections, which is precisely why
// serverless hosting is ruled out.
const server = http.createServer(app);
const wss = attachWebSocket(server);
const stopScheduler = startScheduler();

server.listen(env.PORT, () => {
  logger.info('pollhub api listening', {
    port: env.PORT,
    env: env.NODE_ENV,
    behindCloudflare: env.BEHIND_CLOUDFLARE,
  });
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });

  stopScheduler();
  // Close sockets explicitly: server.close() waits for connections to end,
  // and an idle WebSocket never ends on its own.
  for (const socket of wss.clients) socket.close(1001, 'Server shutting down');
  wss.close();

  server.close(async () => {
    await closePool();
    process.exit(0);
  });

  // Do not hang forever on a stuck connection during a deploy.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', { reason: String(reason) });
});
