/**
 * Origin allow-list shared by Express, Socket.IO and Better Auth.
 *
 * The Vite dev server falls back to 5174, 5175, ... whenever 5173 is already
 * taken, so any loopback origin is accepted regardless of port. Non-local
 * frontends can be added with the CORS_ORIGINS env var (comma separated).
 */

const LOOPBACK_ORIGIN_PATTERN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

function normalize(origin) {
  return String(origin).trim().replace(/\/+$/, '');
}

function extraOrigins() {
  return (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(normalize)
    .filter(Boolean);
}

/** True when a browser running on `origin` is allowed to call this API. */
function isAllowedOrigin(origin) {
  // Requests without an Origin header (curl, server-to-server, native apps)
  // are not subject to CORS.
  if (!origin) return true;

  const normalized = normalize(origin);
  return (
    extraOrigins().includes(normalized) || LOOPBACK_ORIGIN_PATTERN.test(normalized)
  );
}

/**
 * `origin` callback for the `cors` package, which both Express and Socket.IO
 * use. Reflecting the request origin keeps `credentials: true` valid; denied
 * origins receive no CORS headers at all.
 */
function corsOrigin(origin, callback) {
  if (isAllowedOrigin(origin)) return callback(null, origin || true);
  return callback(null, false);
}

module.exports = { isAllowedOrigin, corsOrigin };
