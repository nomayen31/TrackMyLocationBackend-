/**
 * LAN identity tokens.
 *
 * There is no password auth on an offline hotspot, so the Pi issues a short
 * signed token when a visitor picks a display name. This is *not* a replacement
 * for account security — it only stops one device from trivially claiming to be
 * another device, and gives the server a stable id for presence and signalling.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256)
 */
const crypto = require('crypto');

const TTL_MS = 24 * 60 * 60 * 1000; // a day is plenty for one trip

// A random secret per boot is fine for a hotspot; set LAN_SECRET to keep
// tokens valid across restarts.
let cachedSecret = null;
function secret() {
  if (process.env.LAN_SECRET) return process.env.LAN_SECRET;
  if (!cachedSecret) cachedSecret = crypto.randomBytes(32).toString('hex');
  return cachedSecret;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

/** Issue a token for a visitor. */
function issueToken({ deviceId, name }) {
  const payload = {
    deviceId: String(deviceId).slice(0, 64),
    name: String(name || '').trim().slice(0, 40) || 'Guest',
    iat: Date.now(),
    exp: Date.now() + TTL_MS,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

/** Verify a token; returns claims or null. */
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;

  const expected = sign(body);
  // Constant-time comparison.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!claims?.deviceId || !claims?.exp) return null;
    if (Date.now() > claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}

module.exports = { issueToken, verifyToken, TTL_MS };
