const { auth } = require('../auth');
const { fromNodeHeaders } = require('better-auth/node');

/**
 * Express middleware that resolves the current user from the
 * Better Auth session cookie and attaches it to `req.user`.
 */
module.exports = async function authMiddleware(req, res, next) {
  try {
    const headers = fromNodeHeaders(req.headers);
    const session = await auth.api.getSession({ headers });

    if (!session) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.user = session.user;
    req.session = session.session;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(401).json({ error: 'Unauthorized' });
  }
};
