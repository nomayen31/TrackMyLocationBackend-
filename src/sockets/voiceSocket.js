/**
 * voiceSocket — the application-level voice protocol over Socket.IO.
 *
 * IMPORTANT: audio NEVER travels through Socket.IO. This layer only carries
 * room presence, invites, mute state and the LiveKit *access token*. The actual
 * audio is peer-to-server over WebRTC, brokered by LiveKit.
 *
 * Every handler responds through an acknowledgement:
 *   { ok: true,  data: {...} }
 *   { ok: false, error: { code, message } }
 *
 * Server-side authorization is enforced in the services; the client is never
 * trusted for room ids, owner ids or identity.
 *
 * Events
 *   client → server: voice:room:create | voice:room:join | voice:room:leave
 *                    voice:room:update | voice:room:delete | voice:room:list
 *                    voice:participant:mute
 *                    voice:invite:send | voice:invite:accept | voice:invite:decline
 *   server → client: voice:room:participants | voice:room:updated
 *                    voice:participant:joined | voice:participant:left
 *                    voice:participant:mute | voice:invite:received
 *                    voice:invite:accepted | voice:invite:declined | voice:error
 */
const pool = require('../config/db');
const presence = require('../voice/presence');
const rooms = require('../voice/voice-room.service');
const invitations = require('../voice/invitation.service');
const livekit = require('../voice/livekit');

const roomKey = (roomId) => `voice_${roomId}`;

/** ok / error acknowledgement helpers (consistent shape for every handler). */
const ok = (data = {}) => ({ ok: true, ...data });
const fail = (code, message) => ({ ok: false, error: { code, message } });

/** Map thrown service errors to codes. */
function errorCode(err) {
  return err?.code || 'INTERNAL';
}

/** Small per-socket throttle for mutating verbs. */
function makeThrottle(windowMs) {
  const last = new Map();
  return (key) => {
    const now = Date.now();
    if (now - (last.get(key) || 0) < windowMs) return false;
    last.set(key, now);
    return true;
  };
}

/** Resolve display info for the users currently present in a room. */
async function participantsPayload(roomId) {
  const ids = presence.userIds(roomId);
  if (ids.length === 0) return [];

  const result = await pool.query(
    'SELECT id, name, COALESCE(image, "avatarUrl") AS "avatarUrl" FROM "user" WHERE id = ANY($1)',
    [ids]
  );
  const byId = new Map(result.rows.map((r) => [r.id, r]));

  return ids.map((userId) => ({
    userId,
    name: byId.get(userId)?.name || 'Member',
    avatarUrl: byId.get(userId)?.avatarUrl || null,
    muted: presence.isMuted(roomId, userId),
  }));
}

async function broadcastParticipants(io, roomId) {
  const participants = await participantsPayload(roomId);
  io.to(roomKey(roomId)).emit('voice:room:participants', { roomId, participants });
  return participants;
}

module.exports = function voiceSocket(io, socket) {
  const me = socket.user;
  const allowCreate = makeThrottle(5000);
  const allowInvite = makeThrottle(2000);

  /* ------------------------------------------------------------------ list */
  socket.on('voice:room:list', async (_payload, ack) => {
    try {
      const list = await rooms.listRooms(me.id);
      // Attach the live participant count from presence (not the DB).
      const withCounts = list.map((r) => ({ ...r, liveCount: presence.count(r.id) }));
      if (typeof ack === 'function') ack(ok({ rooms: withCounts }));
    } catch (err) {
      console.error('voice:room:list error:', err.message);
      if (typeof ack === 'function') ack(fail('INTERNAL', 'Could not list rooms'));
    }
  });

  /* ---------------------------------------------------------------- create */
  socket.on('voice:room:create', async ({ name, isPrivate, maxParticipants, groupId } = {}, ack) => {
    try {
      if (!allowCreate(me.id)) {
        if (typeof ack === 'function') ack(fail('RATE_LIMITED', 'Slow down a moment'));
        return;
      }
      const room = await rooms.createRoom({
        name,
        ownerId: me.id,
        isPrivate: Boolean(isPrivate),
        maxParticipants,
        groupId: groupId || null,
      });
      io.emit('voice:room:updated', { room: { ...room, liveCount: 0 }, action: 'created' });
      if (typeof ack === 'function') ack(ok({ room }));
    } catch (err) {
      console.error('voice:room:create error:', err.message);
      if (typeof ack === 'function') ack(fail(errorCode(err), err.message || 'Could not create room'));
    }
  });

  /* ------------------------------------------------------------ update/delete */
  socket.on('voice:room:update', async ({ roomId, name, isPrivate, maxParticipants } = {}, ack) => {
    try {
      const room = await rooms.getRoom(roomId);
      if (!room) return void (typeof ack === 'function' && ack(fail('NOT_FOUND', 'Room not found')));
      if (room.ownerId !== me.id) {
        return void (typeof ack === 'function' && ack(fail('FORBIDDEN', 'Only the owner can edit this room')));
      }
      const updated = await rooms.updateRoom(roomId, { name, isPrivate, maxParticipants });
      io.emit('voice:room:updated', { room: updated, action: 'updated' });
      if (typeof ack === 'function') ack(ok({ room: updated }));
    } catch (err) {
      if (typeof ack === 'function') ack(fail(errorCode(err), err.message));
    }
  });

  socket.on('voice:room:delete', async ({ roomId } = {}, ack) => {
    try {
      const room = await rooms.getRoom(roomId);
      if (!room) return void (typeof ack === 'function' && ack(fail('NOT_FOUND', 'Room not found')));
      if (room.ownerId !== me.id) {
        return void (typeof ack === 'function' && ack(fail('FORBIDDEN', 'Only the owner can delete this room')));
      }

      await invitations.revokeForRoom(roomId);
      await rooms.deleteRoom(roomId);

      // Evict everyone: clear presence and tell the room to disconnect.
      for (const userId of presence.userIds(roomId)) presence.removeUser(roomId, userId);
      io.to(roomKey(roomId)).emit('voice:room:deleted', { roomId });
      io.in(roomKey(roomId)).socketsLeave(roomKey(roomId));
      io.emit('voice:room:updated', { room: { id: roomId }, action: 'deleted' });

      if (typeof ack === 'function') ack(ok({ roomId }));
    } catch (err) {
      console.error('voice:room:delete error:', err.message);
      if (typeof ack === 'function') ack(fail('INTERNAL', 'Could not delete room'));
    }
  });

  /* ------------------------------------------------------------------ join */
  socket.on('voice:room:join', async ({ roomId, muted = false } = {}, ack) => {
    try {
      const access = await rooms.canJoin(roomId, me.id);
      if (!access.ok) {
        const messages = {
          not_found: 'Room not found',
          banned: 'You are banned from this room',
          invite_required: 'This room is private — you need an invitation',
        };
        if (typeof ack === 'function') ack(fail(access.reason.toUpperCase(), messages[access.reason] || 'Cannot join'));
        return;
      }

      const room = access.room;

      // Capacity check against live presence (excluding this user's tabs).
      const alreadyIn = presence.count(roomId) > 0 && presence.userIds(roomId).includes(me.id);
      if (!alreadyIn && presence.count(roomId) >= room.maxParticipants) {
        if (typeof ack === 'function') ack(fail('ROOM_FULL', 'This room is full'));
        return;
      }

      // Ask LiveKit for a scoped token (never exposed: the secret stays server-side).
      let token;
      try {
        token = await livekit.createVoiceToken({
          roomName: room.livekitRoom,
          identity: me.id,
          name: me.name,
          metadata: { roomId: room.id },
        });
      } catch (lkErr) {
        console.error('LiveKit token error:', lkErr.code || lkErr.message);
        if (typeof ack === 'function') {
          ack(fail(lkErr.code || 'LIVEKIT_ERROR', 'Voice service is unavailable right now'));
        }
        return;
      }

      const firstTab = presence.add(roomId, me.id, socket.id, { muted: Boolean(muted) });
      socket.join(roomKey(roomId));

      const participants = await participantsPayload(roomId);

      if (firstTab) {
        socket.to(roomKey(roomId)).emit('voice:participant:joined', {
          roomId,
          participant: participants.find((p) => p.userId === me.id),
        });
      }
      // Everyone (including the joiner) gets the authoritative participant list.
      io.to(roomKey(roomId)).emit('voice:room:participants', { roomId, participants });

      if (typeof ack === 'function') {
        ack(ok({
          room,
          token,
          livekitUrl: process.env.LIVEKIT_URL || null,
          participants,
          muted: presence.isMuted(roomId, me.id),
        }));
      }
    } catch (err) {
      console.error('voice:room:join error:', err.message);
      if (typeof ack === 'function') ack(fail('INTERNAL', 'Could not join the room'));
    }
  });

  /* ----------------------------------------------------------------- leave */
  socket.on('voice:room:leave', async ({ roomId } = {}, ack) => {
    try {
      const lastOne = presence.remove(roomId, me.id, socket.id);
      socket.leave(roomKey(roomId));

      if (lastOne) {
        socket.to(roomKey(roomId)).emit('voice:participant:left', { roomId, userId: me.id });
      }
      await broadcastParticipants(io, roomId);
      if (typeof ack === 'function') ack(ok({ roomId }));
    } catch (err) {
      if (typeof ack === 'function') ack(fail('INTERNAL', 'Could not leave the room'));
    }
  });

  /* ------------------------------------------------------------ mute state */
  socket.on('voice:participant:mute', async ({ roomId, muted } = {}, ack) => {
    try {
      if (!presence.userIds(roomId).includes(me.id)) {
        if (typeof ack === 'function') ack(fail('NOT_IN_ROOM', 'You are not in this room'));
        return;
      }
      presence.setMuted(roomId, me.id, muted);
      io.to(roomKey(roomId)).emit('voice:participant:mute', {
        roomId,
        userId: me.id,
        muted: Boolean(muted),
      });
      if (typeof ack === 'function') ack(ok({ muted: Boolean(muted) }));
    } catch (err) {
      if (typeof ack === 'function') ack(fail('INTERNAL', 'Could not update mute state'));
    }
  });

  /* -------------------------------------------------------------- invitations */
  socket.on('voice:invite:send', async ({ roomId, recipientId } = {}, ack) => {
    try {
      if (!allowInvite(me.id)) {
        if (typeof ack === 'function') ack(fail('RATE_LIMITED', 'Slow down a moment'));
        return;
      }

      const room = await rooms.getRoom(roomId);
      if (!room) return void (typeof ack === 'function' && ack(fail('NOT_FOUND', 'Room not found')));
      if (room.ownerId !== me.id) {
        return void (typeof ack === 'function' && ack(fail('FORBIDDEN', 'Only the owner can invite to this room')));
      }

      const invitation = await invitations.createInvitation({ roomId, senderId: me.id, recipientId });

      // Notify the recipient on every device/tab (their personal room).
      io.to(`user_${invitation.recipientId}`).emit('voice:invite:received', { invitation });
      if (typeof ack === 'function') ack(ok({ invitation }));
    } catch (err) {
      if (typeof ack === 'function') ack(fail(errorCode(err), err.message || 'Could not send the invitation'));
    }
  });

  socket.on('voice:invite:accept', async ({ invitationId } = {}, ack) => {
    try {
      const invitation = await invitations.respond(invitationId, me.id, 'accept');
      const room = await rooms.getRoom(invitation.roomId);
      if (!room) return void (typeof ack === 'function' && ack(fail('NOT_FOUND', 'Room no longer exists')));

      let token;
      try {
        token = await livekit.createVoiceToken({
          roomName: room.livekitRoom,
          identity: me.id,
          name: me.name,
          metadata: { roomId: room.id },
        });
      } catch (lkErr) {
        if (typeof ack === 'function') ack(fail(lkErr.code || 'LIVEKIT_ERROR', 'Voice service unavailable'));
        return;
      }

      // Let the sender know it was accepted.
      io.to(`user_${invitation.senderId}`).emit('voice:invite:accepted', { invitation });
      if (typeof ack === 'function') ack(ok({ room, token, livekitUrl: process.env.LIVEKIT_URL || null }));
    } catch (err) {
      if (typeof ack === 'function') ack(fail(errorCode(err), err.message || 'Could not accept the invitation'));
    }
  });

  socket.on('voice:invite:decline', async ({ invitationId } = {}, ack) => {
    try {
      const invitation = await invitations.respond(invitationId, me.id, 'decline');
      io.to(`user_${invitation.senderId}`).emit('voice:invite:declined', { invitation });
      if (typeof ack === 'function') ack(ok({ invitationId }));
    } catch (err) {
      if (typeof ack === 'function') ack(fail(errorCode(err), err.message || 'Could not decline the invitation'));
    }
  });

  socket.on('voice:invite:list', async (_payload, ack) => {
    try {
      const list = await invitations.listIncoming(me.id);
      if (typeof ack === 'function') ack(ok({ invitations: list }));
    } catch (err) {
      if (typeof ack === 'function') ack(fail('INTERNAL', 'Could not load invitations'));
    }
  });

  /* --------------------------------------------------------------- disconnect */
  // A user may have several tabs; only announce "left" when the last one goes.
  socket.on('disconnect', async () => {
    for (const { roomId, userId } of presence.roomsForSocket(socket.id)) {
      const lastOne = presence.remove(roomId, userId, socket.id);
      if (lastOne) {
        io.to(roomKey(roomId)).emit('voice:participant:left', { roomId, userId });
        broadcastParticipants(io, roomId).catch(() => {});
      }
    }
  });
};
