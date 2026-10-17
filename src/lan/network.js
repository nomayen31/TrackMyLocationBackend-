/**
 * Network helpers — deciding who is "on the hotspot".
 *
 * A browser has no API to list WiFi devices, so discovery is done server-side:
 * the Pi sees each device's IP, and devices sharing its subnet (the /24 the
 * access point hands out, normally 192.168.4.x) are treated as "in the signal".
 */

/** Normalise IPv4-mapped IPv6 and strip ports. */
function normalizeIp(raw) {
  let ip = String(raw || '').trim();
  if (!ip) return '';
  // "::ffff:192.168.4.7" -> "192.168.4.7"
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  // "[::1]:1234" / "192.168.4.7:1234"
  ip = ip.replace(/^\[|\]$/g, '');
  if (ip.includes(':') && ip.split(':').length === 2) ip = ip.split(':')[0];
  return ip;
}

/** True for loopback addresses (local development). */
function isLoopback(ip) {
  return ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.');
}

/** True for RFC1918 private ranges (a LAN / hotspot). */
function isPrivate(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The "network key" used to group devices. A /24 of the client's address —
 * so every phone attached to the Pi's AP (192.168.4.x) shares one key.
 */
function subnetOf(rawIp) {
  const ip = normalizeIp(rawIp);
  if (!ip) return null;
  if (isLoopback(ip)) return 'loopback';
  const parts = ip.split('.');
  if (parts.length !== 4) return ip; // IPv6 etc. — exact match only
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

/** True when both addresses would be on the same access point. */
function sameNetwork(a, b) {
  const sa = subnetOf(a);
  const sb = subnetOf(b);
  return Boolean(sa && sb && sa === sb);
}

module.exports = { normalizeIp, isLoopback, isPrivate, subnetOf, sameNetwork };
