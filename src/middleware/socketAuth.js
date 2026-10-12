const { auth } = require('../auth');
const { fromNodeHeaders } = require('better-auth/node');

/**
 * Socket.IO middleware that resolves the current user from the
 * Better Auth session cookie and attaches it to `socket.user`.
 */
module.exports = async function socketAuth(socket, next) {
  try {
    const headers = fromNodeHeaders(socket.handshake.headers);
    const session = await auth.api.getSession({ headers });

    if (!session) {
      return next(new Error('Unauthorized'));
    }

    socket.user = session.user;
    socket.session = session.session;
    next();
  } catch (err) {
    console.error('Socket auth error:', err);
    next(new Error('Unauthorized'));
  }
};
