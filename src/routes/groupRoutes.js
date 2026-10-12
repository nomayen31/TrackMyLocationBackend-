const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');

// Every route in this file requires a valid session.
router.use(authMiddleware);

// Base URL of the frontend, used to build invite links / QR targets.
const CLIENT_URL = (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/+$/, '');

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
    const existing = await pool.query('SELECT 1 FROM groups WHERE invite_code = $1', [code]);
    if (existing.rows.length === 0) return code;
  }
  throw new Error('Could not generate a unique invite code');
}

/** Generate a cryptographically unique, unguessable invite token (URL/QR). */
function generateInviteToken() {
  return crypto.randomBytes(24).toString('base64url');
}

/** Build the public invite link that a QR code should encode. */
function inviteLink(token) {
  return `${CLIENT_URL}/join/${token}`;
}

/** Attach the socket server (if available) so REST changes can fan out. */
function emitGroupUpdate(req, groupId, payload = {}) {
  const io = req.app.get('io');
  if (io) io.to(`group_${groupId}`).emit('group-updated', { groupId: Number(groupId), ...payload });
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
    const inviteToken = generateInviteToken();

    // 1. Create the group
    const groupResult = await client.query(
      `INSERT INTO groups (name, invite_code, invite_token, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, invite_code, invite_token, created_by, created_at`,
      [name.trim(), inviteCode, inviteToken, req.user.id]
    );
    const group = groupResult.rows[0];

    // 2. The creator automatically joins as an admin
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [group.id, req.user.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ group: { ...group, invite_link: inviteLink(inviteToken) } });
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

// POST /api/groups/join  -> join a group using its short invite code  { inviteCode }
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

    emitGroupUpdate(req, group.id, { reason: 'member-joined', userId: req.user.id });
    res.status(201).json({ group, membership: insert.rows[0] });
  } catch (err) {
    console.error('Join group error:', err);
    res.status(500).json({ error: 'Failed to join group' });
  }
});

// POST /api/groups/invite/:token/join
// -> auto-join via an invite link / scanned QR code (idempotent).
router.post('/invite/:token/join', async (req, res) => {
  try {
    const { token } = req.params;

    const groupResult = await pool.query(
      `SELECT id, name, invite_code, created_by, created_at
       FROM groups
       WHERE invite_token = $1 AND invite_enabled = TRUE`,
      [token]
    );
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'This invite link is invalid or has been disabled' });
    }
    const group = groupResult.rows[0];

    const insert = await pool.query(
      `INSERT INTO group_members (group_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (group_id, user_id) DO NOTHING
       RETURNING group_id, user_id, role, joined_at`,
      [group.id, req.user.id]
    );

    const alreadyMember = insert.rows.length === 0;
    if (!alreadyMember) {
      emitGroupUpdate(req, group.id, { reason: 'member-joined', userId: req.user.id });
    }

    res.status(alreadyMember ? 200 : 201).json({
      group,
      alreadyMember,
      membership: insert.rows[0] || { group_id: group.id, user_id: req.user.id, role: 'member' },
    });
  } catch (err) {
    console.error('Auto-join by invite error:', err);
    res.status(500).json({ error: 'Failed to join via invite' });
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

// GET /api/groups/:groupId/invite  -> invite code + link (for sharing / QR)
router.get('/:groupId/invite', async (req, res) => {
  try {
    const { groupId } = req.params;

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    // Lazily backfill a token for groups created before invite links existed.
    let result = await pool.query(
      'SELECT invite_code, invite_token FROM groups WHERE id = $1',
      [groupId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (!result.rows[0].invite_token) {
      result = await pool.query(
        'UPDATE groups SET invite_token = $1 WHERE id = $2 RETURNING invite_code, invite_token',
        [generateInviteToken(), groupId]
      );
    }

    const { invite_code, invite_token } = result.rows[0];
    res.json({ inviteCode: invite_code, inviteToken: invite_token, inviteLink: inviteLink(invite_token) });
  } catch (err) {
    console.error('Get invite error:', err);
    res.status(500).json({ error: 'Failed to build invite' });
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
      `SELECT u.id, u.name, u.email, u.image, u."avatarUrl", u.phone, u.social, gm.role, gm.joined_at
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
      `SELECT u.id, u.name, u.email, u.image, u."avatarUrl", u.phone, u.social, gm.role, gm.joined_at
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

    emitGroupUpdate(req, groupId, { reason: 'member-added', userId: newUser.id });
    res.status(201).json({ member: { ...newUser, ...insert.rows[0] } });
  } catch (err) {
    console.error('Add member error:', err);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// PATCH /api/groups/:groupId/members/:userId  -> promote / demote   { role }
// body: { role: 'admin' | 'member' }  (admins only)
router.patch('/:groupId/members/:userId', async (req, res) => {
  try {
    const { groupId, userId } = req.params;
    const { role } = req.body || {};

    if (!['admin', 'member'].includes(role)) {
      return res.status(400).json({ error: "role must be 'admin' or 'member'" });
    }

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }
    if (membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only group admins can change roles' });
    }

    const groupResult = await pool.query('SELECT created_by FROM groups WHERE id = $1', [groupId]);
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    // The creator stays an admin — cannot be demoted.
    if (groupResult.rows[0].created_by === userId && role === 'member') {
      return res.status(400).json({ error: 'The group creator cannot be demoted' });
    }

    const updated = await pool.query(
      `UPDATE group_members SET role = $1
       WHERE group_id = $2 AND user_id = $3
       RETURNING group_id, user_id, role`,
      [role, groupId, userId]
    );
    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found in this group' });
    }

    emitGroupUpdate(req, groupId, { reason: 'role-changed', userId, role });
    res.json({ member: updated.rows[0] });
  } catch (err) {
    console.error('Update role error:', err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// DELETE /api/groups/:groupId/members/:userId  -> kick a member (admins only)
router.delete('/:groupId/members/:userId', async (req, res) => {
  try {
    const { groupId, userId } = req.params;

    const membership = await getMembership(groupId, req.user.id);
    if (!membership) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }
    if (membership.role !== 'admin') {
      return res.status(403).json({ error: 'Only group admins can remove members' });
    }
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot remove yourself; leave the group instead' });
    }

    const groupResult = await pool.query('SELECT created_by FROM groups WHERE id = $1', [groupId]);
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }
    if (groupResult.rows[0].created_by === userId) {
      return res.status(400).json({ error: 'The group creator cannot be removed' });
    }

    const removed = await pool.query(
      `DELETE FROM group_members
       WHERE group_id = $1 AND user_id = $2
       RETURNING group_id, user_id`,
      [groupId, userId]
    );
    if (removed.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found in this group' });
    }

    // Notify the whole group (and the removed member directly) so the UI updates.
    emitGroupUpdate(req, groupId, { reason: 'member-removed', userId });
    const io = req.app.get('io');
    if (io) io.to(`user_${userId}`).emit('removed-from-group', { groupId: Number(groupId) });

    res.json({ ok: true, removed: removed.rows[0] });
  } catch (err) {
    console.error('Kick member error:', err);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

module.exports = router;
