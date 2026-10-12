/**
 * adminSocket — admin-only safety controls.
 *
 *   set-safe-zone    -> create/update the geofenced radius (broadcasts `safe-zone-updated`)
 *   disable-safe-zone-> turn the safe zone off
 *   admin-broadcast  -> send a Notice / Alert / Danger announcement to the trip
 *                       (broadcasts `admin-broadcast-message`)
 *
 * Every handler re-checks the admin role server-side; the client is never trusted.
 */
const pool = require('../config/db');
const { upsertZone, disableZone } = require('../safeZones');

const MIN_RADIUS_M = 50;
const MAX_RADIUS_M = 100_000; // 100 km
const LEVELS = ['notice', 'warning', 'danger'];

async function isAdmin(groupId, userId) {
  const result = await pool.query(
    'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return result.rows[0]?.role === 'admin';
}

module.exports = function adminSocket(io, socket) {
  const me = socket.user;

  /* --------------------------------------------------------- safe zone */
  socket.on('set-safe-zone', async ({ groupId, radiusM, enabled = true, centerLat, centerLng } = {}, ack) => {
    try {
      const radius = Number(radiusM);
      if (!groupId || !Number.isFinite(radius)) {
        if (typeof ack === 'function') ack({ error: 'groupId and radiusM are required' });
        return;
      }
      if (radius < MIN_RADIUS_M || radius > MAX_RADIUS_M) {
        if (typeof ack === 'function') ack({ error: 'Radius must be between 50 m and 100 km' });
        return;
      }
      if (!(await isAdmin(groupId, me.id))) {
        if (typeof ack === 'function') ack({ error: 'Only trip admins can set the safe zone' });
        return;
      }

      const zone = await upsertZone({
        groupId,
        radiusM: Math.round(radius),
        enabled,
        ownerUserId: me.id,
        // The centre is refined on the owner's next `update-location` tick.
        centerLat: Number.isFinite(Number(centerLat)) ? Number(centerLat) : null,
        centerLng: Number.isFinite(Number(centerLng)) ? Number(centerLng) : null,
      });

      io.to(`group_${groupId}`).emit('safe-zone-updated', zone);
      if (typeof ack === 'function') ack({ ok: true, zone });
    } catch (err) {
      console.error('set-safe-zone error:', err);
      if (typeof ack === 'function') ack({ error: 'Could not set the safe zone' });
    }
  });

  socket.on('disable-safe-zone', async ({ groupId } = {}, ack) => {
    try {
      if (!groupId) return;
      if (!(await isAdmin(groupId, me.id))) {
        if (typeof ack === 'function') ack({ error: 'Only trip admins can change the safe zone' });
        return;
      }
      const zone = await disableZone(groupId);
      io.to(`group_${groupId}`).emit('safe-zone-updated', zone);
      if (typeof ack === 'function') ack({ ok: true, zone });
    } catch (err) {
      console.error('disable-safe-zone error:', err);
      if (typeof ack === 'function') ack({ error: 'Could not disable the safe zone' });
    }
  });

  /* --------------------------------------------------- map announcements */
  socket.on('admin-broadcast', async ({ groupId, type, title, message } = {}, ack) => {
    try {
      if (!groupId || !LEVELS.includes(type)) {
        if (typeof ack === 'function') ack({ error: 'groupId and a valid type are required' });
        return;
      }
      if (!(await isAdmin(groupId, me.id))) {
        if (typeof ack === 'function') ack({ error: 'Only trip admins can broadcast' });
        return;
      }

      const broadcast = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        groupId: Number(groupId),
        type,
        title: String(title || '').trim().slice(0, 120),
        message: String(message || '').trim().slice(0, 500),
        senderName: me.name,
        at: Date.now(),
      };

      io.to(`group_${groupId}`).emit('admin-broadcast-message', broadcast);
      if (typeof ack === 'function') ack({ ok: true, broadcast });
    } catch (err) {
      console.error('admin-broadcast error:', err);
      if (typeof ack === 'function') ack({ error: 'Could not send the broadcast' });
    }
  });
};
