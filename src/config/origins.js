/**
 * Origin allow-list shared by Express, Socket.IO and Better Auth.
 *
 * - Any loopback origin (any port) is allowed, so the Vite dev server can fall
 *   back to 5174/5175 without breaking the API.
 * - `CLIENT_URL` (the deployed frontend) is always allowed.
 * - `CORS_ORIGINS` accepts a comma-separated list for extra origins
 *   (e.g. a Vercel preview URL or a custom domain).
 */

const LOOPBACK_ORIGIN_PATTERN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

function normalize(origin) {
  return String(origin).trim().replace(/\/+$/, '');
}

function extraOrigins() {
  return [
    process.env.CLIENT_URL,
    ...(process.env.CORS_ORIGINS || '').split(','),
  ]
    .map((o) => (o ? normalize(o) : ''))
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
