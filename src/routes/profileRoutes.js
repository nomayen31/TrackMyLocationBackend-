const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');

// Every route in this file requires a valid session.
router.use(authMiddleware);

const MAX_AVATAR_LENGTH = 2 * 1024 * 1024; // ~2 MB of base64 text
const USER_COLUMNS = 'id, name, email, image, "avatarUrl", phone, social';

/** The full profile shape the client uses for the current user. */
function shape(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
    avatarUrl: row.avatarUrl || row.image || null,
    phone: row.phone || null,
    social: row.social || null,
  };
}

// GET /api/profile/me  -> the signed-in user's full profile (incl. phone/social)
router.get('/me', async (req, res) => {
  try {
    const result = await pool.query(`SELECT ${USER_COLUMNS} FROM "user" WHERE id = $1`, [
      req.user.id,
    ]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: shape(result.rows[0]) });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// PATCH /api/profile  -> update name / photo / phone / social
// body: { name?, image?, phone?, social? }
router.patch('/', async (req, res) => {
  try {
    const { name, image, phone, social } = req.body || {};
    const updates = [];
    const values = [];

    if (name !== undefined) {
      const clean = String(name).trim();
      if (!clean) return res.status(400).json({ error: 'Name cannot be empty' });
      if (clean.length > 80) return res.status(400).json({ error: 'Name is too long' });
      values.push(clean);
      updates.push(`name = $${values.length}`);
    }

    if (image !== undefined) {
      if (image === null || image === '') {
        updates.push('image = NULL', '"avatarUrl" = NULL');
      } else {
        const data = String(image);
        if (!/^data:image\//i.test(data) && !/^https?:\/\//i.test(data)) {
          return res.status(400).json({ error: 'Photo must be an image' });
        }
        if (data.length > MAX_AVATAR_LENGTH) {
          return res.status(413).json({ error: 'Photo is too large (max ~2 MB)' });
        }
        values.push(data);
        updates.push(`image = $${values.length}`, `"avatarUrl" = $${values.length}`);
      }
    }

    if (phone !== undefined) {
      const clean = String(phone).trim().slice(0, 32);
      values.push(clean || null);
      updates.push(`phone = $${values.length}`);
    }

    if (social !== undefined) {
      const clean = String(social).trim().slice(0, 120);
      values.push(clean || null);
      updates.push(`social = $${values.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    values.push(req.user.id);
    const result = await pool.query(
      `UPDATE "user" SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING ${USER_COLUMNS}`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const user = shape(result.rows[0]);

    // Let everyone sharing a trip with this user refresh their avatar/details.
    try {
      const io = req.app.get('io');
      if (io) {
        const groups = await pool.query('SELECT group_id FROM group_members WHERE user_id = $1', [
          req.user.id,
        ]);
        for (const g of groups.rows) {
          io.to(`group_${g.group_id}`).emit('member-profile-updated', user);
        }
      }
    } catch (emitErr) {
      console.error('Profile broadcast failed:', emitErr.message);
    }

    res.json({ user });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
