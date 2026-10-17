const { LAN_MODE } = require('../lan/config');
const { verifyToken } = require('../lan/token');
const { normalizeIp, subnetOf } = require('../lan/network');

/**
 * Socket.IO auth middleware.
 *
 * LAN mode (hotspot): verifies the signed LAN token issued by POST /api/lan/join.
 * Cloud mode: resolves the Better Auth session cookie, exactly as before.
 *
 * Better Auth is required lazily so that an offline Pi never initialises the
 * cloud auth/database stack.
 */
module.exports = async function socketAuth(socket, next) {
  try {
    if (LAN_MODE) {
      const token = socket.handshake.auth?.lanToken || socket.handshake.query?.lanToken;
      const claims = verifyToken(token);
      if (!claims) return next(new Error('Unauthorized'));

      socket.user = {
        id: `lan_${claims.deviceId}`,
        name: claims.name,
        lan: true,
        deviceId: claims.deviceId,
      };
      socket.lan = {
        deviceId: claims.deviceId,
        ip: normalizeIp(socket.handshake.address),
        network: subnetOf(socket.handshake.address),
      };
      return next();
    }

    const { auth } = require('../auth');
    // `better-auth/node` is ESM-only in v1.7+ — import() is the safe form.
    const { fromNodeHeaders } = await import('better-auth/node');

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
