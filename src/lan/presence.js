/**
 * LAN presence — who is currently "in the signal" (on the hotspot).
 *
 * Keyed by deviceId (not socket id, which changes on reconnect). Entries expire
 * after LAN_PRESENCE_TTL_MS without a heartbeat, so a device that vanishes never
 * lingers in the list.
 */
const { LAN_PRESENCE_TTL_MS } = require('./config');

// deviceId -> { deviceId, name, ip, network, socketId, joinedAt, lastSeen }
const devices = new Map();

let sweeper = null;
function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const cutoff = Date.now() - LAN_PRESENCE_TTL_MS;
    for (const [id, d] of devices) {
      if (d.lastSeen < cutoff) devices.delete(id);
    }
  }, 10_000);
  // Never keep the process alive just for the sweeper.
  sweeper.unref?.();
}

/** Add or refresh a device. Returns true when it is newly seen. */
function upsert({ deviceId, name, ip, network, socketId }) {
  ensureSweeper();
  const existing = devices.get(deviceId);
  const now = Date.now();

  if (existing) {
    existing.name = name || existing.name;
    existing.ip = ip || existing.ip;
    existing.network = network || existing.network;
    existing.socketId = socketId || existing.socketId;
    existing.lastSeen = now;
    return false;
  }

  devices.set(deviceId, {
    deviceId,
    name: name || 'Guest',
    ip,
    network,
    socketId,
    joinedAt: now,
    lastSeen: now,
  });
  return true;
}

/** Heartbeat. */
function touch(deviceId) {
  const d = devices.get(deviceId);
  if (d) d.lastSeen = Date.now();
  return Boolean(d);
}

function remove(deviceId) {
  return devices.delete(deviceId);
}

function get(deviceId) {
  return devices.get(deviceId) || null;
}

/** Everyone on the same network key, freshest first. */
function listByNetwork(network) {
  const cutoff = Date.now() - LAN_PRESENCE_TTL_MS;
  return [...devices.values()]
    .filter((d) => d.network === network && d.lastSeen >= cutoff)
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      joinedAt: d.joinedAt,
    }));
}

function countByNetwork(network) {
  return listByNetwork(network).length;
}

/** Test helper. */
function reset() {
  devices.clear();
}

module.exports = { upsert, touch, remove, get, listByNetwork, countByNetwork, reset };
