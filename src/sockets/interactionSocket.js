/**
 * interactionSocket — realtime social actions between group members.
 *
 *   send-dm      -> persist a 1:1 direct message           (direct_messages)
 *   vibrate-user -> make a member's phone buzz             (Vibration API)
 *   ring-user    -> play a ringtone on a member's device   (Web Audio API)
 *   stop-ring    -> cancel a ringtone
 *
 * Every event targets the recipient's personal room (`user_<id>`), which is
 * joined on connection — so a user is reachable on every device/tab they
 * have open, regardless of which group room they are currently viewing.
 *
 * The sender's identity always comes from the verified session (`socket.user`),
 * never from the client payload. A lightweight per-socket throttle keeps the
 * poke actions from being used as a spam weapon.
 */
const pool = require('../config/db');
const { normalizeAttachment } = require('../attachments');

const THROTTLE_MS = 2500;

/** True when `userId` belongs to `groupId`. */
async function isMember(groupId, userId) {
  if (!groupId || !userId) return false;
  const result = await pool.query(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return result.rows.length > 0;
}

module.exports = function interactionSocket(io, socket) {
  const me = socket.user;

  // Simple in-memory throttle: at most one poke per target every THROTTLE_MS.
  const lastPoke = new Map();
  function throttled(targetId) {
    const now = Date.now();
    const prev = lastPoke.get(targetId) || 0;
    if (now - prev < THROTTLE_MS) return true;
    lastPoke.set(targetId, now);
    return false;
  }

  /* ---------------------------------------------------------------- direct messages */
  socket.on('send-dm', async (payload, ack) => {
    try {
      const { toUserId, groupId } = payload || {};
      const text = String(payload?.message ?? '').trim();
      const att = normalizeAttachment(payload?.attachment);

      if (!toUserId || (!text && !att)) {
        if (typeof ack === 'function') ack({ error: 'toUserId and a message or attachment are required' });
        return;
      }
      if (toUserId === me.id) {
        if (typeof ack === 'function') ack({ error: 'You cannot message yourself' });
        return;
      }
      // When a groupId is supplied, both parties must belong to that trip.
      if (groupId && !(await isMember(groupId, toUserId))) {
        if (typeof ack === 'function') ack({ error: 'Recipient is not in this trip' });
        return;
      }

      const result = await pool.query(
        `INSERT INTO direct_messages
           (from_user, to_user, message, attachment_type, attachment_data,
            attachment_mime, attachment_name, duration_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, from_user, to_user, message, created_at, read_at,
                   attachment_type, attachment_data, attachment_mime,
                   attachment_name, duration_seconds`,
        [
          me.id,
          toUserId,
          text,
          att?.type || null,
          att?.data || null,
          att?.mime || null,
          att?.name || null,
          att?.duration || null,
        ]
      );

      const dm = {
        ...result.rows[0],
        fromName: me.name,
        fromAvatar: me.image || me.avatarUrl || null,
        groupId: groupId ?? null,
      };

      // Deliver to the recipient and echo to the sender's other tabs/devices.
      io.to(`user_${toUserId}`).emit('receive-dm', dm);
      io.to(`user_${me.id}`).emit('receive-dm', dm);

      if (typeof ack === 'function') ack({ ok: true, dm });
    } catch (err) {
      console.error('Error saving direct message:', err);
      if (typeof ack === 'function') ack({ error: 'Could not send message' });
    }
  });

  /* ---------------------------------------------------------------------- vibrate */
  socket.on('vibrate-user', async ({ toUserId, groupId } = {}) => {
    try {
      if (!toUserId || toUserId === me.id) return;
      if (throttled(`v-${toUserId}`)) return;
      if (groupId && !(await isMember(groupId, toUserId))) return;

      io.to(`user_${toUserId}`).emit('vibrate', {
        fromUserId: me.id,
        fromName: me.name,
        pattern: [220, 90, 220, 90, 420],
        at: Date.now(),
      });
    } catch (err) {
      console.error('Error sending vibrate:', err);
    }
  });

  /* -------------------------------------------------------------------------- ring */
  socket.on('ring-user', async ({ toUserId, groupId } = {}) => {
    try {
      if (!toUserId || toUserId === me.id) return;
      if (throttled(`r-${toUserId}`)) return;
      if (groupId && !(await isMember(groupId, toUserId))) return;

      io.to(`user_${toUserId}`).emit('ring', {
        fromUserId: me.id,
        fromName: me.name,
        at: Date.now(),
      });
    } catch (err) {
      console.error('Error sending ring:', err);
    }
  });

  socket.on('stop-ring', ({ toUserId } = {}) => {
    if (!toUserId) return;
    io.to(`user_${toUserId}`).emit('ring-stopped', { fromUserId: me.id });
  });
};
