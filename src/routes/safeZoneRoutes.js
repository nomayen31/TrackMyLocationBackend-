const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');
const { loadZone, upsertZone, disableZone } = require('../safeZones');

// Every route in this file requires a valid session.
router.use(authMiddleware);

/** Returns the membership row (or null) for a user in a group. */
async function getMembership(groupId, userId) {
  const result = await pool.query(
    'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return result.rows[0] || null;
}

// GET /api/safezone/:groupId  -> the group's current safe zone (members only).
// Useful on page load / after a reconnect (the socket `join-group` also pushes it).
router.get('/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    const zone = await loadZone(groupId);
    res.json({ zone: zone || null });
  } catch (err) {
    console.error('Get safe zone error:', err);
    res.status(500).json({ error: 'Failed to fetch the safe zone' });
  }
});

// PUT /api/safezone/:groupId  -> set the radius / toggle it on (admins only)
// body: { radiusM, enabled?, centerLat?, centerLng? }
router.put('/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { radiusM, enabled = true, centerLat, centerLng } = req.body || {};

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }
    if (membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only trip admins can set the safe zone' });
    }

    if (!enabled) {
      const zone = await disableZone(groupId);
      const io = req.app.get('io');
      if (io) io.to(`group_${groupId}`).emit('safe-zone-updated', zone);
      return res.json({ zone });
    }

    const radius = Number(radiusM);
    if (!Number.isFinite(radius) || radius < 50 || radius > 100000) {
      return res.status(400).json({ error: 'radiusM must be between 50 and 100000' });
    }

    const zone = await upsertZone({
      groupId,
      radiusM: Math.round(radius),
      enabled: true,
      ownerUserId: req.user.id,
      centerLat: Number.isFinite(Number(centerLat)) ? Number(centerLat) : null,
      centerLng: Number.isFinite(Number(centerLng)) ? Number(centerLng) : null,
    });

    const io = req.app.get('io');
    if (io) io.to(`group_${groupId}`).emit('safe-zone-updated', zone);

    res.json({ zone });
  } catch (err) {
    console.error('Set safe zone error:', err);
    res.status(500).json({ error: 'Failed to set the safe zone' });
  }
});

module.exports = router;
