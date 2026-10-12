const { betterAuth } = require('better-auth');
const pool = require('./config/db');
const { isAllowedOrigin } = require('./config/origins');

// The deployed frontend (e.g. *.vercel.app) and the API host (e.g. *.onrender.com)
// are different sites, so the session cookie must be sent cross-site. That
// requires SameSite=None + Secure, which only works over HTTPS. Locally we keep
// the permissive dev defaults so `npm run dev` on http://localhost still works.
const isProd = process.env.NODE_ENV === 'production';
const crossSiteCookies = isProd || process.env.CROSS_SITE_COOKIES === 'true';

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
  ...(crossSiteCookies
    ? {
        advanced: {
          defaultCookieAttributes: {
            sameSite: 'none',
            secure: true,
            httpOnly: true,
            path: '/',
          },
        },
      }
    : {}),
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

module.exports = { auth };