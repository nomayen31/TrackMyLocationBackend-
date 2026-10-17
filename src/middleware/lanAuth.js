/**
 * lanAuth — verifies the signed LAN identity token (see src/lan/token.js).
 *
 * Used only in LAN mode, where cloud auth (Better Auth + Neon) is unavailable.
 * Attaches `req.user` in the same shape the rest of the app expects:
 *   { id, name, deviceId, lan: true }
 */
const { verifyToken } = require('../lan/token');
const { normalizeIp, subnetOf } = require('../lan/network');

function readToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.headers['x-lan-token'] || null;
}

module.exports = function lanAuth(req, res, next) {
  const claims = verifyToken(readToken(req));
  if (!claims) {
    return res.status(401).json({ error: 'Not joined to this hotspot' });
  }
  req.user = {
    id: `lan_${claims.deviceId}`,
    name: claims.name,
    deviceId: claims.deviceId,
    lan: true,
  };
  req.lan = {
    ip: normalizeIp(req.ip || req.socket?.remoteAddress),
    network: subnetOf(req.ip || req.socket?.remoteAddress),
  };
  next();
};

module.exports.readToken = readToken;
