const { betterAuth } = require('better-auth');
const pool = require('./config/db');
const { isAllowedOrigin } = require('./config/origins');

const auth = betterAuth({
  database: pool,
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:5000',
  secret: process.env.BETTER_AUTH_SECRET,
  // Trust the same origins as the API: any loopback port, so the Vite dev
  // server may move off 5173 without being rejected here.
  trustedOrigins: (request) => {
    const origin = request?.headers?.get?.('origin');
    return origin && isAllowedOrigin(origin) ? [origin] : [];
  },
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