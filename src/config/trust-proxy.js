import { env } from './env.js';

/**
 * Published Cloudflare edge ranges.
 * Source: https://www.cloudflare.com/ips/ — refresh periodically.
 *
 * This list is the entire basis for trusting `CF-Connecting-IP`. If it goes
 * stale, real voters start hashing to the proxy address and deduplication
 * silently collapses.
 */
export const CLOUDFLARE_IPV4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

export const CLOUDFLARE_IPV6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/**
 * Value for `app.set('trust proxy', ...)`.
 *
 * NEVER return boolean `true`. That trusts `X-Forwarded-For` from any source,
 * which lets a client spoof its own address and defeat deduplication entirely
 * — strictly worse than having no deduplication, because the results still
 * look trustworthy.
 */
export function trustProxyValue() {
  // Local reverse proxy (Caddy/nginx) on the same host.
  const local = ['loopback', 'linklocal', 'uniquelocal'];
  if (!env.BEHIND_CLOUDFLARE) return local;
  return [...local, ...CLOUDFLARE_IPV4, ...CLOUDFLARE_IPV6];
}
