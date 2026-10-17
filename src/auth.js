const { betterAuth } = require('better-auth');
const { bearer } = require('better-auth/plugins');
const pool = require('./config/db');
const { isAllowedOrigin } = require('./config/origins');

// The deployed frontend (e.g. *.vercel.app) and the API host (e.g. *.onrender.com)
// are different sites, so the session cookie must be sent cross-site. That
// requires SameSite=None + Secure, which only works over HTTPS. Locally we keep
// the permissive dev defaults so `npm run dev` on http://localhost still works.
// ---------------------------------------------------------------------------
// Cookie policy
// ---------------------------------------------------------------------------
// The frontend and the API are usually on DIFFERENT sites in production
// (e.g. app.vercel.app -> api.onrender.com). Browsers only send cookies across
// sites when they are `SameSite=None; Secure`. With the default `Lax`, signing
// up appears to work but every following request is 401 Unauthorized.
//
// Do not rely on NODE_ENV alone — a host may not set it. Derive the policy from
// the configured URLs, and allow an explicit override.
function resolveCookiePolicy() {
  const override = String(process.env.COOKIE_SAMESITE || '').trim().toLowerCase();
  if (override === 'none') return { mode: 'none', sameSite: 'none', secure: true };
  if (override === 'lax') return { mode: 'lax', sameSite: 'lax', secure: false };

  const httpsBase = /^https:\/\//i.test(process.env.BETTER_AUTH_URL || '');
  const httpsClient = /^https:\/\//i.test(process.env.CLIENT_URL || '');
  const isProd = process.env.NODE_ENV === 'production';

  // Any HTTPS deployment is cross-site-capable -> use None + Secure.
  if (httpsBase || httpsClient || isProd || process.env.CROSS_SITE_COOKIES === 'true') {
    return { mode: 'none', sameSite: 'none', secure: true };
  }
  return { mode: 'lax', sameSite: 'lax', secure: false };
}

const cookiePolicy = resolveCookiePolicy();

const auth = betterAuth({
  database: pool,
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:5000',
  secret: process.env.BETTER_AUTH_SECRET,
  // Trust the same origins as the API: any loopback port, plus CLIENT_URL /
  // CORS_ORIGINS so the deployed frontend is accepted.
  trustedOrigins: (request) => {
    const origin = request?.headers?.get?.('origin');
    return origin && isAllowedOrigin(origin) ? [origin] : [];
  },
  advanced: {
    defaultCookieAttributes: {
      sameSite: cookiePolicy.sameSite,
      secure: cookiePolicy.secure,
      httpOnly: true,
      path: '/',
    },
  },
  // Bearer tokens make auth work even when the browser refuses to store or send
  // the session cookie. That happens whenever the frontend and the API are on
  // different *sites* — and `vercel.app` and `onrender.com` are both in the
  // Public Suffix List, so `*.vercel.app -> *.onrender.com` is always cross-site.
  // Safari (ITP), Firefox (Total Cookie Protection) and Brave block such cookies
  // by default: sign-in returns 200, the next request has no cookie, and the app
  // bounces back to the sign-in page. The plugin accepts
  // `Authorization: Bearer <token>` (the `token` returned by sign-up/sign-in),
  // and the cookie still works as a fallback for same-site deployments.
  plugins: [bearer()],
  emailAndPassword: {
    enabled: true,
    // Keep sign-ups simple for local development (no email verification flow yet)
    requireEmailVerification: false,
  },
  session: {
    // Sessions should survive a browser restart; tokens remain valid for 30 days.
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  user: {
    additionalFields: {
      avatarUrl: {
        type: 'string',
        required: false,
        defaultValue: 'https://github.com/shadcn.png',
      },
    },
  },
});

// Startup diagnostics (no secrets): makes cookie mistakes obvious in the log.
console.log(
  `🍪 Auth cookies: SameSite=${cookiePolicy.sameSite}${cookiePolicy.secure ? '; Secure' : ''} ` +
    `[${cookiePolicy.mode}] · baseURL=${process.env.BETTER_AUTH_URL || 'http://localhost:5000 (default)'}`
);
if (cookiePolicy.mode === 'lax' && !/^https?:\/\/localhost/i.test(process.env.BETTER_AUTH_URL || '')) {
  console.warn(
    '⚠️  Cookie policy is Lax, which browsers will not send cross-site. ' +
      'Set BETTER_AUTH_URL/CLIENT_URL to your https URLs, or COOKIE_SAMESITE=none.'
  );
}

module.exports = { auth, cookiePolicy };