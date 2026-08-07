/**
 * PM2 process definition.
 *
 * `instances: 1` is load-bearing, not a placeholder. Cluster mode would give
 * each worker its own in-memory rate limiter, its own tally mirror, and its
 * own set of WebSocket clients — so a voter's rate limit would depend on
 * which worker answered, and a tally broadcast would reach only the fraction
 * of subscribers on that worker. Scaling out means moving those three things
 * out of process memory first.
 */
export default {
  apps: [
    {
      name: 'pollhub-api',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
      out_file: '/var/log/pollhub/out.log',
      error_file: '/var/log/pollhub/err.log',
      time: true,
      kill_timeout: 12000, // longer than the 10s shutdown guard in server.js
    },
  ],
};
