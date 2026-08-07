import { WebSocketServer } from 'ws';
import { subscribe, unsubscribeAll, broadcast } from './channels.js';
import * as mirror from './tally-mirror.js';
import { queryOne } from '../db/pool.js';
import { logger } from '../lib/logger.js';

const HEARTBEAT_MS = 30_000;

/**
 * WebSocket server attached to the SAME HTTP server as the REST API.
 *
 * This is the constraint that rules out serverless hosting: there is no
 * persistent process on Vercel or Workers to hold these connections, and the
 * tally mirror they read from would have nowhere to live.
 */
export function attachWebSocket(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(socket, { type: 'error', message: 'Invalid JSON' });
      }

      if (msg.type === 'subscribe') return handleSubscribe(socket, msg);
      if (msg.type === 'ping') return send(socket, { type: 'pong' });
      send(socket, { type: 'error', message: `Unknown message type: ${msg.type}` });
    });

    socket.on('close', () => unsubscribeAll(socket));
    socket.on('error', (err) => logger.warn('ws socket error', { err: err.message }));
  });

  // Terminate sockets that stopped answering. Without this, dropped mobile
  // connections accumulate until the process runs out of file descriptors.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);

  wss.on('close', () => clearInterval(heartbeat));

  logger.info('websocket server attached', { path: '/ws' });
  return wss;
}

async function handleSubscribe(socket, msg) {
  const pollId = msg.pollId;
  if (!pollId) return send(socket, { type: 'error', message: 'pollId is required' });

  // Results visibility is enforced here, not just in the REST layer —
  // otherwise a creator-only poll leaks its live tally over the socket.
  const poll = await queryOne(
    'SELECT id, status, results_mode FROM polls WHERE id = $1',
    [pollId],
  );
  if (!poll) return send(socket, { type: 'error', message: 'Poll not found' });

  if (poll.results_mode === 'creator_only') {
    return send(socket, { type: 'error', message: 'Live results are not public for this poll' });
  }
  if (poll.results_mode === 'after_close' && poll.status !== 'closed') {
    return send(socket, { type: 'error', message: 'Results are published after the poll closes' });
  }

  subscribe(socket, pollId);
  send(socket, { type: 'snapshot', pollId, tallies: await mirror.snapshot(pollId) });
}

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

/** Push a committed tally delta to everyone watching the poll. */
export function publishTallyDelta(pollId, delta) {
  if (!delta) return 0;
  return broadcast(pollId, { type: 'tally', pollId, tallies: delta });
}

export function publishPollStatus(pollId, status) {
  return broadcast(pollId, { type: 'status', pollId, status });
}
