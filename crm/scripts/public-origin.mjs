import { isIP } from 'node:net';

export function publicHttpsOrigin(value, label) {
  if (!value) throw new Error(`${label} is required.`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) {
    throw new Error(`${label} must be a plain HTTPS origin on port 443.`);
  }
  if (!url.hostname.includes('.') || isIP(url.hostname) || url.hostname === 'localhost' || url.hostname.endsWith('.local')) {
    throw new Error(`${label} must use a public DNS hostname.`);
  }
  if (value !== url.origin) {
    throw new Error(`${label} must be the exact origin without a trailing slash or other suffix.`);
  }
  return url.origin;
}
