const { getDistance } = require('geolib');
const { getZone, loadZone, moveCenter } = require('../safeZones');

/**
 * locationSocket — live positions + server-side geofencing.
 *
 *   update-location -> broadcast `user-moved`, then evaluate the group's safe
 *                      zone. If a member crosses the boundary we emit
 *                      `boundary-breach-alert`; when they return inside we emit
 *                      `boundary-restored`. State is tracked per member so we
 *                      only fire on the *transition*, not on every GPS tick.
 *
 * The zone centre follows the admin who created it (their position updates the
 * centre rather than being checked against it).
 */

// groupId -> Set(userId) currently outside the boundary
const outsideMembers = new Map();

function metersBetween(centerLat, centerLng, lat, lng) {
  return getDistance(
    { latitude: centerLat, longitude: centerLng },
    { latitude: lat, longitude: lng }
  );
}

module.exports = function locationSocket(io, socket) {
  socket.on('update-location', async ({ groupId, lat, lng } = {}) => {
    if (!groupId || lat == null || lng == null) return;

    // 1. Fan the live position out to the group.
    socket.to(`group_${groupId}`).emit('user-moved', {
      userId: socket.user.id,
      lat,
      lng,
      name: socket.user.name,
      avatarUrl: socket.user.image || socket.user.avatarUrl,
    });

    // 2. Geofence evaluation.
    try {
      const zone = getZone(groupId) || (await loadZone(groupId));
      if (!zone || !zone.enabled) return;

      // The zone owner's own movement re-centres the circle.
      if (zone.ownerUserId === socket.user.id) {
        moveCenter(groupId, lat, lng);
        return;
      }
      if (zone.centerLat == null || zone.centerLng == null) return;

      const distanceM = metersBetween(zone.centerLat, zone.centerLng, lat, lng);
      const id = Number(groupId);
      const set = outsideMembers.get(id) || new Set();
      const nowOutside = distanceM > zone.radiusM;
      const wasOutside = set.has(socket.user.id);

      if (nowOutside && !wasOutside) {
        set.add(socket.user.id);
        outsideMembers.set(id, set);
        io.to(`group_${groupId}`).emit('boundary-breach-alert', {
          userId: socket.user.id,
          name: socket.user.name,
          distanceM: Math.round(distanceM),
          radiusM: zone.radiusM,
          at: Date.now(),
        });
      } else if (!nowOutside && wasOutside) {
        set.delete(socket.user.id);
        io.to(`group_${groupId}`).emit('boundary-restored', {
          userId: socket.user.id,
          name: socket.user.name,
          distanceM: Math.round(distanceM),
          radiusM: zone.radiusM,
          at: Date.now(),
        });
      }
    } catch (err) {
      console.error('Geofence evaluation error:', err.message);
    }
  });
};
