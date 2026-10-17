const express = require('express');
const router = express.Router();

const { issueToken, verifyToken } = require('../lan/token');
const { normalizeIp, subnetOf } = require('../lan/network');
const { LAN_MODE, LAN_MAX_PEERS, LAN_NETWORK_NAME } = require('../lan/config');
const presence = require('../lan/presence');
const lanAuth = require('../middleware/lanAuth');

/** Public bootstrap: tells the client whether to run the hotspot UI. */
router.get('/info', (req, res) => {
  const ip = normalizeIp(req.ip || req.socket?.remoteAddress);
  res.json({
    lanMode: LAN_MODE,
    networkName: LAN_NETWORK_NAME,
    maxPeers: LAN_MAX_PEERS,
    // The client is told which /24 the server sees it on — useful in the UI
    // ("you're on 192.168.4.x").
    subnet: subnetOf(ip) || null,
    // Never expose secrets or the server's own IP beyond what's already public.
    serverTime: new Date().toISOString(),
  });
});

/**
 * Pick a display name and receive a signed LAN token.
 * `deviceId` is generated and stored by the browser (localStorage) so a reload
 * keeps the same identity.
 */
router.post('/join', (req, res) => {
  if (!LAN_MODE) {
    return res.status(404).json({ error: 'LAN mode is not enabled' });
  }
  const { name, deviceId } = req.body || {};
  const cleanName = String(name || '').trim();
  const cleanDevice = String(deviceId || '').trim();

  if (!cleanDevice || cleanDevice.length < 6) {
    return res.status(400).json({ error: 'A valid deviceId is required' });
  }
  if (!cleanName) {
    return res.status(400).json({ error: 'Please enter a display name' });
  }

  const ip = normalizeIp(req.ip || req.socket?.remoteAddress);
  const network = subnetOf(ip);

  const token = issueToken({ deviceId: cleanDevice, name: cleanName });
  presence.upsert({ deviceId: cleanDevice, name: cleanName, ip, network, socketId: null });

  res.json({
    token,
    user: { id: `lan_${cleanDevice}`, name: cleanName, deviceId: cleanDevice, lan: true },
    networkName: LAN_NETWORK_NAME,
  });
});

/** Who is currently on this hotspot. */
router.get('/nearby', lanAuth, (req, res) => {
  const nearby = presence.listByNetwork(req.lan.network);
  res.json({ nearby, count: nearby.length, maxPeers: LAN_MAX_PEERS });
});

/** Validate an existing token on page load (so the UI can skip the name form). */
router.get('/me', (req, res) => {
  const token = lanAuth.readToken(req);
  const claims = verifyToken(token);
  if (!claims) return res.status(401).json({ error: 'Invalid or expired session' });
  res.json({ user: { id: `lan_${claims.deviceId}`, name: claims.name, deviceId: claims.deviceId, lan: true } });
});

module.exports = router;
