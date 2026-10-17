/**
 * Mesh roster — who is in the group voice call on this hotspot.
 *
 * A full mesh means every participant opens a peer connection to every other
 * participant, so the roster is capped (LAN_MAX_PEERS). On a Pi 4/5 six people
 * is comfortable; four is the safe ceiling on a Zero 2 W.
 */
const { LAN_MAX_PEERS } = require('./config');

// deviceId -> { deviceId, name, socketId, joinedAt }
const members = new Map();

function join({ deviceId, name, socketId }) {
  const existing = members.get(deviceId);
  if (existing) {
    existing.socketId = socketId;
    existing.name = name || existing.name;
    return { ok: true, already: true };
  }
  if (members.size >= LAN_MAX_PEERS) {
    return { ok: false, reason: 'full', limit: LAN_MAX_PEERS };
  }
  members.set(deviceId, { deviceId, name: name || 'Guest', socketId, joinedAt: Date.now() });
  return { ok: true, already: false };
}

function leave(deviceId) {
  return members.delete(deviceId);
}

function get(deviceId) {
  return members.get(deviceId) || null;
}

/** Roster for the client (no IPs, no socket ids). */
function list() {
  return [...members.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((m) => ({ deviceId: m.deviceId, name: m.name }));
}

/** Everyone except `deviceId` (used to notify peers). */
function others(deviceId) {
  return [...members.values()].filter((m) => m.deviceId !== deviceId);
}

function size() {
  return members.size;
}

function reset() {
  members.clear();
}

module.exports = { join, leave, get, list, others, size, reset, LAN_MAX_PEERS };
