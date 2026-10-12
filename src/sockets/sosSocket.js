/**
 * sosSocket — expedition safety signal.
 *
 *   sos-alert -> broadcast an emergency signal to the rest of the trip
 *   sos-clear -> tell the trip the emergency is over
 *
 * The signal carries the sender's name and, when available, their last known
 * coordinates so other members can find them on the map.
 */
const pool = require('../config/db');

module.exports = function sosSocket(io, socket) {
  const me = socket.user;

  socket.on('sos-alert', async ({ groupId, lat, lng, message } = {}) => {
    try {
      if (!groupId) return;

      const membership = await pool.query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
        [groupId, me.id]
      );
      if (membership.rows.length === 0) return;

      const payload = {
        fromUserId: me.id,
        fromName: me.name,
        avatarUrl: me.image || me.avatarUrl || null,
        groupId,
        lat: Number.isFinite(Number(lat)) ? Number(lat) : null,
        lng: Number.isFinite(Number(lng)) ? Number(lng) : null,
        message: String(message || 'Needs help').slice(0, 200),
        at: Date.now(),
      };

      // Alert the rest of the trip; echo to the sender's other tabs.
      socket.to(`group_${groupId}`).emit('sos', payload);
      io.to(`user_${me.id}`).emit('sos-sent', payload);
    } catch (err) {
      console.error('sos-alert error:', err);
    }
  });

  socket.on('sos-clear', ({ groupId } = {}) => {
    if (!groupId) return;
    socket.to(`group_${groupId}`).emit('sos-cleared', { fromUserId: me.id, groupId });
  });
};
