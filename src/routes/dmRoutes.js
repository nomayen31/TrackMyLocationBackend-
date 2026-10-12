const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');

// Every route in this file requires a valid session.
router.use(authMiddleware);

// GET /api/dm  -> recent 1:1 conversations for the current user.
// Returns one row per peer with the latest message preview.
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (peer) peer,
              dm.id, dm.message, dm.from_user, dm.to_user, dm.created_at, dm.read_at,
              u.name AS peer_name,
              COALESCE(u.image, u."avatarUrl") AS peer_avatar
       FROM (
         SELECT *,
                CASE WHEN from_user = $1 THEN to_user ELSE from_user END AS peer
         FROM direct_messages
         WHERE from_user = $1 OR to_user = $1
       ) dm
       JOIN "user" u ON u.id = dm.peer
       ORDER BY peer, dm.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List conversations error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// GET /api/dm/:otherUserId  -> full conversation history (oldest first).
// Marks messages sent to you by that peer as read.
router.get('/:otherUserId', async (req, res) => {
  try {
    const me = req.user.id;
    const other = req.params.otherUserId;

    const result = await pool.query(
      `SELECT dm.id, dm.from_user, dm.to_user, dm.message, dm.created_at, dm.read_at,
              u.name AS from_name,
              COALESCE(u.image, u."avatarUrl") AS from_avatar
       FROM direct_messages dm
       JOIN "user" u ON u.id = dm.from_user
       WHERE (dm.from_user = $1 AND dm.to_user = $2)
          OR (dm.from_user = $2 AND dm.to_user = $1)
       ORDER BY dm.created_at ASC
       LIMIT 500`,
      [me, other]
    );

    await pool.query(
      `UPDATE direct_messages SET read_at = NOW()
       WHERE to_user = $1 AND from_user = $2 AND read_at IS NULL`,
      [me, other]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('Fetch conversation error:', err);
    res.status(500).json({ error: 'Failed to fetch conversation' });
  }
});

// POST /api/dm  -> REST fallback for sending a direct message  { toUserId, message }
router.post('/', async (req, res) => {
  try {
    const { toUserId, message } = req.body || {};
    const text = String(message ?? '').trim();

    if (!toUserId || !text) {
      return res.status(400).json({ error: 'toUserId and message are required' });
    }
    if (toUserId === req.user.id) {
      return res.status(400).json({ error: 'You cannot message yourself' });
    }

    const result = await pool.query(
      `INSERT INTO direct_messages (from_user, to_user, message)
       VALUES ($1, $2, $3)
       RETURNING id, from_user, to_user, message, created_at, read_at`,
      [req.user.id, toUserId, text.slice(0, 2000)]
    );

    const dm = {
      ...result.rows[0],
      fromName: req.user.name,
      fromAvatar: req.user.image || req.user.avatarUrl || null,
    };

    // Live-deliver to the recipient and the sender's other tabs.
    const io = req.app.get('io');
    if (io) {
      io.to(`user_${toUserId}`).emit('receive-dm', dm);
      io.to(`user_${req.user.id}`).emit('receive-dm', dm);
    }

    res.status(201).json({ dm });
  } catch (err) {
    console.error('Send direct message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
