const { auth } = require('../auth');

/**
 * Express middleware that resolves the current user from the
 * Better Auth session cookie and attaches it to `req.user`.
 *
 * `better-auth/node` is an ES module in v1.7+, so it is imported dynamically;
 * a static require() throws ERR_REQUIRE_ESM on runtimes without require(ESM).
 */
module.exports = async function authMiddleware(req, res, next) {
  try {
    const { fromNodeHeaders } = await import('better-auth/node');
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
