import { logger } from '../lib/logger.js';

/**
 * Channel registry: `poll:{id}` -> Set of sockets.
 *
 * Deliberately in-process. A managed WebSocket service (Pusher, Ably) would
 * do this too, but the brief rules them out and a single Node process holds
 * far more idle connections than this app will have concurrent voters.
 */
const channels = new Map();

export function subscribe(socket, pollId) {
  const key = `poll:${pollId}`;
  if (!channels.has(key)) channels.set(key, new Set());
  channels.get(key).add(socket);

  socket.subscriptions ??= new Set();
  socket.subscriptions.add(key);
}

export function unsubscribeAll(socket) {
  for (const key of socket.subscriptions ?? []) {
    const set = channels.get(key);
    if (!set) continue;
    set.delete(socket);
    // Drop empty sets so the map does not grow unbounded across a long uptime.
    if (set.size === 0) channels.delete(key);
  }
  socket.subscriptions?.clear();
}

export function broadcast(pollId, payload) {
  const set = channels.get(`poll:${pollId}`);
  if (!set || set.size === 0) return 0;

  const frame = JSON.stringify(payload);
  let delivered = 0;

  for (const socket of set) {
    if (socket.readyState !== socket.OPEN) continue;
    try {
      socket.send(frame);
      delivered += 1;
    } catch (err) {
      logger.warn('ws send failed', { err: err.message });
    }
  }
  return delivered;
}

export function subscriberCount(pollId) {
  return channels.get(`poll:${pollId}`)?.size ?? 0;
}

export function stats() {
  return { channels: channels.size };
}
