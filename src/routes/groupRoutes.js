const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');

// Every route in this file requires a valid session.
router.use(authMiddleware);

/** Returns { role } if the user belongs to the group, otherwise null. */
async function getMembership(groupId, userId) {
  const result = await pool.query(
    'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return result.rows[0] || null;
}

/** Generate a short, unambiguous, URL-friendly invite code. */
function generateInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}

/** Generate a unique invite code (retries on the rare collision). */
async function generateUniqueInviteCode() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateInviteCode();
    const existing = await pool.query(
      'SELECT 1 FROM groups WHERE invite_code = $1',
      [code]
    );
    if (existing.rows.length === 0) return code;
  }
  throw new Error('Could not generate a unique invite code');
}

// POST /api/groups/create  -> create a group   { name }
// POST /api/groups         -> alias for /create
async function createGroupHandler(req, res) {
  const client = await pool.connect();
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    await client.query('BEGIN');

    const inviteCode = await generateUniqueInviteCode();

    // 1. Create the group
    const groupResult = await client.query(
      `INSERT INTO groups (name, invite_code, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, name, invite_code, created_by, created_at`,
      [name.trim(), inviteCode, req.user.id]
    );
    const group = groupResult.rows[0];

    // 2. The creator automatically joins as an admin
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [group.id, req.user.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ group });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create group error:', err);
    res.status(500).json({ error: 'Failed to create group' });
  } finally {
    client.release();
  }
}

router.post('/', createGroupHandler);
router.post('/create', createGroupHandler);

// POST /api/groups/join  -> join a group using its invite code  { inviteCode }
router.post('/join', async (req, res) => {
  try {
    const { inviteCode } = req.body || {};

    if (!inviteCode) {
      return res.status(400).json({ error: 'inviteCode is required' });
    }

    const code = String(inviteCode).trim().toUpperCase();

    const groupResult = await pool.query(
      'SELECT id, name, invite_code, created_by, created_at FROM groups WHERE invite_code = $1',
      [code]
    );
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid invite code' });
    }
    const group = groupResult.rows[0];

    // Idempotent: joining twice does not fail.
    const insert = await pool.query(
      `INSERT INTO group_members (group_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (group_id, user_id) DO NOTHING
       RETURNING group_id, user_id, role, joined_at`,
      [group.id, req.user.id]
    );

    if (insert.rows.length === 0) {
      return res.status(409).json({ error: 'You are already a member of this group' });
    }

    res.status(201).json({ group, membership: insert.rows[0] });
  } catch (err) {
    console.error('Join group error:', err);
    res.status(500).json({ error: 'Failed to join group' });
  }
});

// GET /api/groups  -> list the groups the current user belongs to
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.id, g.name, g.invite_code, g.created_by, g.created_at, gm.role
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = $1
       ORDER BY g.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List groups error:', err);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// GET /api/groups/user/:userId  -> all groups a specific user belongs to
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT g.id, g.name, g.invite_code, g.created_by, g.created_at, gm.role
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = $1
       ORDER BY g.created_at DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List user groups error:', err);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// GET /api/groups/:groupId  -> group details with its members
router.get('/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    const groupResult = await pool.query(
      'SELECT id, name, invite_code, created_by, created_at FROM groups WHERE id = $1',
      [groupId]
    );
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.email, gm.role, gm.joined_at
       FROM group_members gm
       JOIN "user" u ON u.id = gm.user_id
       WHERE gm.group_id = $1
       ORDER BY gm.joined_at ASC`,
      [groupId]
    );

    res.json({ group: groupResult.rows[0], members: membersResult.rows });
  } catch (err) {
    console.error('Get group error:', err);
    res.status(500).json({ error: 'Failed to fetch group' });
  }
});

// GET /api/groups/:groupId/members  -> list all members of a group
router.get('/:groupId/members', async (req, res) => {
  try {
    const { groupId } = req.params;

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.image, u."avatarUrl", gm.role, gm.joined_at
       FROM group_members gm
       JOIN "user" u ON u.id = gm.user_id
       WHERE gm.group_id = $1
       ORDER BY gm.joined_at ASC`,
      [groupId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error('List members error:', err);
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// POST /api/groups/:groupId/members  -> add/invite a user   { email } or { userId }
router.post('/:groupId/members', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { email, userId } = req.body;

    if (!email && !userId) {
      return res.status(400).json({ error: 'Provide a user email or userId' });
    }

    // Only an admin of the group may add members
    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }
    if (membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only group admins can add members' });
    }

    // Resolve the target user by email or id
    const userResult = email
      ? await pool.query('SELECT id, name, email FROM "user" WHERE email = $1', [email])
      : await pool.query('SELECT id, name, email FROM "user" WHERE id = $1', [userId]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const newUser = userResult.rows[0];

    // ON CONFLICT keeps this idempotent if they are already a member
    const insert = await pool.query(
      `INSERT INTO group_members (group_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (group_id, user_id) DO NOTHING
       RETURNING group_id, user_id, role, joined_at`,
      [groupId, newUser.id]
    );

    if (insert.rows.length === 0) {
      return res.status(409).json({ error: 'User is already a member of this group' });
    }

    res.status(201).json({ member: { ...newUser, ...insert.rows[0] } });
  } catch (err) {
    console.error('Add member error:', err);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

module.exports = router;