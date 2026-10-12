const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');

// Every route in this file requires a valid session
router.use(authMiddleware);

// Get the message history for a group (with the sender's display name)
router.get('/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    const result = await pool.query(
      `SELECT m.*, u.name AS user_name
       FROM messages m
       JOIN "user" u ON u.id = m.user_id
       WHERE m.group_id = $1
       ORDER BY m.created_at ASC`,
      [groupId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

module.exports = router;
