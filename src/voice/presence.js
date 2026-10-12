/**
 * presence — application-level presence for voice rooms.
 *
 * This is deliberately SEPARATE from LiveKit's media-room membership: LiveKit
 * tells us who is actually publishing audio; presence tells us who has the app
 * open for a room (including people joining muted). The socket layer reconciles
 * the two.
 *
 * Live connection state lives in memory only — socket ids are never persisted
 * as identity. A user may have several tabs open, so each user maps to a Set of
 * socket ids, and the user is only considered "gone" when the last tab leaves.
 */

// roomId -> Map(userId -> { socketIds:Set<string>, muted:boolean, joinedAt:number })
const rooms = new Map();

function roomMap(roomId) {
  const id = Number(roomId);
  if (!rooms.has(id)) rooms.set(id, new Map());
  return rooms.get(id);
}

/** Add a socket for a user; returns true if this is the user's first tab. */
function add(roomId, userId, socketId, { muted = false } = {}) {
  const map = roomMap(roomId);
  const existing = map.get(userId);
  if (existing) {
    existing.socketIds.add(socketId);
    // Preserve an explicit mute state; a second tab shouldn't unmute you.
    if (typeof muted === 'boolean' && existing.muted == null) existing.muted = muted;
    return false;
  }
  map.set(userId, { socketIds: new Set([socketId]), muted: Boolean(muted), joinedAt: Date.now() });
  return true;
}

/** Remove a socket; returns true if the user has no tabs left in the room. */
function remove(roomId, userId, socketId) {
  const map = rooms.get(Number(roomId));
  if (!map) return false;
  const entry = map.get(userId);
  if (!entry) return false;
  entry.socketIds.delete(socketId);
  if (entry.socketIds.size === 0) {
    map.delete(userId);
    if (map.size === 0) rooms.delete(Number(roomId));
    return true;
  }
  return false;
}

/** Remove a user entirely (kick / leave-all). */
function removeUser(roomId, userId) {
  const map = rooms.get(Number(roomId));
  if (!map) return false;
  const had = map.delete(userId);
  if (map.size === 0) rooms.delete(Number(roomId));
  return had;
}

function setMuted(roomId, userId, muted) {
  const entry = rooms.get(Number(roomId))?.get(userId);
  if (entry) entry.muted = Boolean(muted);
  return Boolean(entry);
}

function isMuted(roomId, userId) {
  return Boolean(rooms.get(Number(roomId))?.get(userId)?.muted);
}

/** User ids currently present in a room. */
function userIds(roomId) {
  return [...(rooms.get(Number(roomId))?.keys() || [])];
}

/** Socket ids for one user in a room (for targeted emits across tabs). */
function socketIdsFor(roomId, userId) {
  return [...(rooms.get(Number(roomId))?.get(userId)?.socketIds || [])];
}

function count(roomId) {
  return rooms.get(Number(roomId))?.size || 0;
}

/** Which rooms has this user joined by socket id? Used on disconnect. */
function roomsForSocket(socketId) {
  const found = [];
  for (const [roomId, map] of rooms.entries()) {
    for (const [userId, entry] of map.entries()) {
      if (entry.socketIds.has(socketId)) found.push({ roomId, userId });
    }
  }
  return found;
}

function snapshot() {
  const out = {};
  for (const [roomId, map] of rooms.entries()) {
    out[roomId] = [...map.entries()].map(([userId, e]) => ({
      userId,
      muted: e.muted,
      tabs: e.socketIds.size,
      joinedAt: e.joinedAt,
    }));
  }
  return out;
}

/** Clear all presence (used by tests). */
function reset() {
  rooms.clear();
}

module.exports = {
  add,
  remove,
  removeUser,
  setMuted,
  isMuted,
  userIds,
  socketIdsFor,
  count,
  roomsForSocket,
  snapshot,
  reset,
};
