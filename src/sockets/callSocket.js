/**
 * callSocket — WebRTC signalling relay for 1:1 voice calls.
 *
 * The server never touches audio: it only forwards SDP offers/answers and ICE
 * candidates between two users' personal rooms (`user_<id>`). The browser does
 * peer-to-peer audio via RTCPeerConnection (STUN for NAT traversal; add a TURN
 * server for restrictive networks — see the frontend `webrtc` config).
 *
 * Call flow:
 *   caller  --call:invite-->  callee        (callee rings)
 *   callee  --call:accept-->  caller        (accepted)
 *   caller  --call:offer ---> callee        (SDP offer)
 *   callee  --call:answer-->  caller        (SDP answer)
 *   both    --call:ice ---->  both          (ICE candidates, trickle)
 *   either  --call:end ---->  other         (hang up)
 *
 * If the callee declines: --call:reject--> caller.
 */
const pool = require('../config/db');

/** True when `userId` belongs to `groupId` (skipped when no group is given). */
async function isMember(groupId, userId) {
  if (!groupId || !userId) return false;
  const result = await pool.query(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return result.rows.length > 0;
}

/** Relay `event` to `toUserId`'s personal room, tagging the sender. */
function relay(io, toUserId, event, from, extra = {}) {
  io.to(`user_${toUserId}`).emit(event, { ...extra, fromUserId: from.id });
}

module.exports = function callSocket(io, socket) {
  const me = socket.user;

  // Ring the callee.
  socket.on('call:invite', async ({ toUserId, groupId, callId, callType } = {}) => {
    try {
      if (!toUserId || !callId || toUserId === me.id) return;
      if (groupId && !(await isMember(groupId, toUserId))) return;

      relay(io, toUserId, 'call:incoming', me, {
        callId,
        callType: callType === 'video' ? 'video' : 'audio',
        fromName: me.name,
        fromAvatar: me.image || me.avatarUrl || null,
        groupId: groupId ?? null,
      });
    } catch (err) {
      console.error('call:invite error:', err);
    }
  });

  socket.on('call:accept', ({ toUserId, callId } = {}) => {
    if (!toUserId || !callId) return;
    relay(io, toUserId, 'call:accepted', me, { callId });
  });

  socket.on('call:reject', ({ toUserId, callId, reason } = {}) => {
    if (!toUserId || !callId) return;
    relay(io, toUserId, 'call:rejected', me, { callId, reason: reason || 'declined' });
  });

  socket.on('call:offer', ({ toUserId, callId, sdp } = {}) => {
    if (!toUserId || !callId || !sdp) return;
    relay(io, toUserId, 'call:offer', me, { callId, sdp });
  });

  socket.on('call:answer', ({ toUserId, callId, sdp } = {}) => {
    if (!toUserId || !callId || !sdp) return;
    relay(io, toUserId, 'call:answer', me, { callId, sdp });
  });

  socket.on('call:ice', ({ toUserId, callId, candidate } = {}) => {
    if (!toUserId || !callId || !candidate) return;
    relay(io, toUserId, 'call:ice', me, { callId, candidate });
  });

  socket.on('call:end', ({ toUserId, callId, reason } = {}) => {
    if (!toUserId || !callId) return;
    relay(io, toUserId, 'call:ended', me, { callId, reason: reason || 'ended' });
  });

  // Let the peer know if a user drops mid-call.
  socket.on('disconnect', () => {
    socket.broadcast.emit('call:user-offline', { userId: me.id });
  });
};
