/**
 * clientUrl — resolves the frontend base URL used to build invite links / QR
 * targets.
 *
 * Order:
 *   1. CLIENT_URL (explicit config — the correct setup for production)
 *   2. the request's Origin header, when it is an allowed origin
 *   3. the request's Origin header when NO allow-list is configured at all
 *      (a misconfigured deployment; better a working link than localhost)
 *   4. the Referer's origin, when allowed
 *   5. the request Host (same-origin deployments such as hotspot mode)
 *   6. http://localhost:5173
 *
 * Note: the Host fallback is only correct when the backend serves the
 * frontend. On split deployments (Vercel/Render), set CLIENT_URL — otherwise
 * step 2/3 covers it because browsers always send Origin on cross-origin XHR.
 */
const { isAllowedOrigin } = require('./origins');

const DEFAULT_CLIENT_URL = 'http://localhost:5173';

function normalizeBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

/** True when the operator has configured any origin allow-list. */
function hasAllowList() {
  return Boolean(
    normalizeBase(process.env.CLIENT_URL) || normalizeBase(process.env.CORS_ORIGINS)
  );
}

function clientBase(req) {
  const configured = normalizeBase(process.env.CLIENT_URL);
  if (configured) return configured;

  const origin = normalizeBase(req?.headers?.origin);
  if (origin) {
    if (isAllowedOrigin(origin) && /^https?:\/\//i.test(origin)) return origin;
    // No allow-list at all: the Origin is the only source of truth we have.
    if (!hasAllowList() && /^https?:\/\//i.test(origin)) return origin;
  }

  const referer = req?.headers?.referer;
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (isAllowedOrigin(refOrigin)) return normalizeBase(refOrigin);
    } catch {
      /* malformed referer */
    }
  }

  const host = req?.headers?.host;
  if (host) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    return `${proto}://${host}`;
  }

  return DEFAULT_CLIENT_URL;
}

module.exports = { clientBase, DEFAULT_CLIENT_URL, hasAllowList };
