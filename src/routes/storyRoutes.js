const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');

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

const ACTIVE_STORY_SELECT = `
  SELECT s.id,
         s.user_id   AS "userId",
         s.group_id  AS "groupId",
         s.media,
         s.caption,
         s.created_at AS "createdAt",
         s.expires_at AS "expiresAt",
         u.name,
         COALESCE(u.image, u."avatarUrl") AS "avatarUrl"
  FROM stories s
  JOIN "user" u ON u.id = s.user_id
`;

// GET /api/stories/group/:groupId  -> every active story shared with the trip
router.get('/group/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    const result = await pool.query(
      `${ACTIVE_STORY_SELECT}
       WHERE s.group_id = $1 AND s.expires_at > NOW()
       ORDER BY s.created_at ASC`,
      [groupId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('List group stories error:', err);
    res.status(500).json({ error: 'Failed to fetch stories' });
  }
});

// GET /api/stories/user/:userId  -> active stories by one member
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `${ACTIVE_STORY_SELECT}
       WHERE s.user_id = $1 AND s.expires_at > NOW()
       ORDER BY s.created_at ASC`,
      [userId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('List user stories error:', err);
    res.status(500).json({ error: 'Failed to fetch stories' });
  }
});

// POST /api/stories  -> REST fallback for posting a story  { groupId, media, caption }
// (The primary path is the `post-story` socket event, which also broadcasts.)
router.post('/', async (req, res) => {
  try {
    const { groupId, media, caption } = req.body || {};

    if (!groupId || !media) {
      return res.status(400).json({ error: 'groupId and media are required' });
    }
    const data = String(media);
    if (!/^data:image\//i.test(data) && !/^https?:\/\//i.test(data)) {
      return res.status(400).json({ error: 'Story must be an image' });
    }

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    const result = await pool.query(
      `INSERT INTO stories (user_id, group_id, media, caption, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + make_interval(hours => 24))
       RETURNING id, user_id AS "userId", group_id AS "groupId", media, caption,
                 created_at AS "createdAt", expires_at AS "expiresAt"`,
      [req.user.id, groupId, data, String(caption || '').trim().slice(0, 200)]
    );

    const story = {
      ...result.rows[0],
      name: req.user.name,
      avatarUrl: req.user.image || req.user.avatarUrl || null,
    };

    // Broadcast to the trip so the story ring appears on the map instantly.
    const io = req.app.get('io');
    if (io) io.to(`group_${groupId}`).emit('story-updated', story);

    res.status(201).json({ story });
  } catch (err) {
    console.error('Create story error:', err);
    res.status(500).json({ error: 'Failed to create story' });
  }
});

// DELETE /api/stories/:id  -> remove one of your own stories
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM stories WHERE id = $1 AND user_id = $2 RETURNING group_id',
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`group_${result.rows[0].group_id}`).emit('story-deleted', { id: Number(id) });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete story error:', err);
    res.status(500).json({ error: 'Failed to delete story' });
  }
});

module.exports = router;
