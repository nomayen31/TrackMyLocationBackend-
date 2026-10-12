/**
 * callSocket — free 1-to-1 WebRTC voice-call signalling (server relays only).
 *
 * The server never touches audio: it forwards SDP offers/answers and ICE
 * candidates between two users' personal rooms (`user_<id>`). Audio flows
 * peer-to-peer; STUN (Google's public server) handles NAT traversal on the
 * client. See the frontend `useCall` hook for the RTCPeerConnection setup.
 *
 * Event names (client <-> server):
 *   call-user      caller -> callee   invite + SDP offer   => `incoming-call`
 *   accept-call    callee -> caller   SDP answer           => `call-accepted`
 *   reject-call    callee -> caller   decline              => `call-rejected`
 *   ice-candidate  both directions    trickle ICE          => `ice-candidate`
 *   hang-up        either             end the call         => `call-ended`
 *
 * Flow:
 *   caller: getMedia -> PC -> createOffer -> `call-user{offer}`
 *   callee: `incoming-call{offer}` -> accept -> setRemote -> createAnswer -> `accept-call{answer}`
 *   caller: `call-accepted{answer}` -> setRemote -> connected
 *   both:   `ice-candidate` trickle
 *   either: `hang-up` -> `call-ended`
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

module.exports = function callSocket(io, socket) {
  const me = socket.user;

  /** Relay an event to a user's personal room, tagging the sender. */
  const send = (toUserId, event, payload = {}) =>
    io.to(`user_${toUserId}`).emit(event, { ...payload, fromUserId: me.id });

  /* -------------------------------------------- caller -> callee: invite + offer */
  const invite = async ({ toUserId, groupId, callId, callType, offer } = {}) => {
    try {
      if (!toUserId || !callId || toUserId === me.id) return;
      if (groupId && !(await isMember(groupId, toUserId))) return;

      send(toUserId, 'incoming-call', {
        callId,
        callType: callType === 'video' ? 'video' : 'audio',
        offer: offer || null,
        fromName: me.name,
        fromAvatar: me.image || me.avatarUrl || null,
        groupId: groupId ?? null,
      });
    } catch (err) {
      console.error('call-user error:', err.message);
    }
  };
  socket.on('call-user', invite);
  socket.on('call:invite', invite); // legacy alias

  /* ---------------------------------------------- callee -> caller: answer / decline */
  const accept = ({ toUserId, callId, answer } = {}) => {
    if (!toUserId || !callId) return;
    send(toUserId, 'call-accepted', { callId, answer: answer || null });
  };
  socket.on('accept-call', accept);
  socket.on('call:accept', accept);

  const reject = ({ toUserId, callId, reason } = {}) => {
    if (!toUserId || !callId) return;
    send(toUserId, 'call-rejected', { callId, reason: reason || 'declined' });
  };
  socket.on('reject-call', reject);
  socket.on('call:reject', reject);

  /* ----------------------------------------------------------------- signal exchange */
  const ice = ({ toUserId, callId, candidate } = {}) => {
    if (!toUserId || !callId || !candidate) return;
    send(toUserId, 'ice-candidate', { callId, candidate });
  };
  socket.on('ice-candidate', ice);
  socket.on('call:ice', ice);

  const hangup = ({ toUserId, callId, reason } = {}) => {
    if (!toUserId || !callId) return;
    send(toUserId, 'call-ended', { callId, reason: reason || 'ended' });
  };
  socket.on('hang-up', hangup);
  socket.on('call:end', hangup);

  // Legacy offer/answer relay (keeps older clients interoperable).
  socket.on('call:offer', ({ toUserId, callId, sdp } = {}) => {
    if (toUserId && callId && sdp) send(toUserId, 'call:offer', { callId, sdp });
  });
  socket.on('call:answer', ({ toUserId, callId, sdp } = {}) => {
    if (toUserId && callId && sdp) send(toUserId, 'call:answer', { callId, sdp });
  });

  // Let peers know a user dropped.
  socket.on('disconnect', () => {
    socket.broadcast.emit('call:user-offline', { userId: me.id });
  });
};
